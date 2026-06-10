/**
 * Metrics module — v0.4.0-rc2 (batch 2).
 *
 * Lightweight in-process metrics for the xiaozhi plugin. No external
 * dependencies (no Prometheus client, no OpenTelemetry SDK) — we just
 * track Counter / Histogram / Gauge primitives in a module-level
 * singleton and expose a JSON snapshot at /api/xiaozhi/metrics.
 *
 * Design goals (Allen 2026-06-10 拍板):
 *   1. Module-level helpers that are no-ops when metricsEnabled=false,
 *      so call sites can stay simple (`observe("foo", 42)`) without
 *      sprinkling `if (enabled)` everywhere.
 *   2. Singleton registry shared by every module — instrumentation in
 *      inbound.ts / esp32ListenHandler.ts / vad.ts / etc. all write to
 *      the same backing store.
 *   3. JSON export shape matches the schema in the spec:
 *      { counters, histograms, gauges, uptime_s, timestamp }
 *   4. When disabled, /api/xiaozhi/metrics returns 404 (the route is
 *      not advertised; tooling shouldn't see it).
 *   5. Per-label-series isolation: `incCounter("foo", {d:"a"})` and
 *      `incCounter("foo", {d:"b"})` produce two distinct series in the
 *      snapshot, even though they share a name.
 *
 * Percentile math: nearest-rank method. For a sorted array of length
 * n, p_X = sorted[ceil(X/100 * n) - 1]. For n=100 and X=50, that gives
 * sorted[49] which is the 50th element (1-indexed 50). On dataset
 * 1..100, p50 = 50, p95 = 95, p99 = 99.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LabelSet = Record<string, string>;

export interface CounterSnapshot {
  name: string;
  labels: LabelSet;
  value: number;
}

export interface HistogramSnapshot {
  name: string;
  labels: LabelSet;
  count: number;
  sum: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface GaugeSnapshot {
  name: string;
  labels: LabelSet;
  value: number;
}

export interface MetricsSnapshot {
  counters: CounterSnapshot[];
  histograms: HistogramSnapshot[];
  gauges: GaugeSnapshot[];
  uptime_s: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export class Counter {
  private v = 0;
  constructor(public readonly name: string) {}
  inc(by: number = 1): void {
    this.v += by;
  }
  value(): number {
    return this.v;
  }
}

export class Gauge {
  private v = 0;
  constructor(public readonly name: string) {}
  set(value: number): void {
    this.v = value;
  }
  inc(by: number = 1): void {
    this.v += by;
  }
  dec(by: number = 1): void {
    this.v -= by;
  }
  value(): number {
    return this.v;
  }
}

export class Histogram {
  private samples: number[] = [];
  private sumTotal = 0;
  constructor(public readonly name: string) {}

  observe(value: number): void {
    this.samples.push(value);
    this.sumTotal += value;
  }

  snapshot(): HistogramSnapshot {
    const count = this.samples.length;
    if (count === 0) {
      return {
        name: this.name,
        labels: {},
        count: 0,
        sum: 0,
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const avg = this.sumTotal / count;
    return {
      name: this.name,
      labels: {},
      count,
      sum: this.sumTotal,
      avg,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }
}

/**
 * Nearest-rank percentile: sorted[ceil(q * n) - 1] for q in (0, 1].
 * For q=0 we return sorted[0] (consistent with p50/p95/p99 of single
 * value).
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Canonicalize a label set so {a:"1",b:"2"} and {b:"2",a:"1"} hash to
 * the same key. We sort keys alphabetically and join with a delimiter
 * that can't appear in label keys or values (NUL + the sorted key=value
 * pairs themselves).
 */
function labelKey(labels: LabelSet | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}\x00${labels[k]}`).join("\x01");
}

export class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();
  private gauges = new Map<string, Gauge>();
  // Parallel maps: name + labelKey → (counters|histograms|gauges) entry
  // We use the metric's own name as the first key, then the labelKey
  // for the per-series map. Two-level map keeps the snapshot sorted
  // by name for human readability.
  private counterSeries = new Map<string, Map<string, { metric: Counter; labels: LabelSet }>>();
  private histogramSeries = new Map<string, Map<string, { metric: Histogram; labels: LabelSet }>>();
  private gaugeSeries = new Map<string, Map<string, { metric: Gauge; labels: LabelSet }>>();

  incCounter(name: string, labels: LabelSet = {}, by: number = 1): void {
    const series = this.getOrCreateCounter(name, labels);
    series.inc(by);
  }

  observe(name: string, value: number, labels: LabelSet = {}): void {
    const series = this.getOrCreateHistogram(name, labels);
    series.observe(value);
  }

  setGauge(name: string, value: number, labels: LabelSet = {}): void {
    const series = this.getOrCreateGauge(name, labels);
    series.set(value);
  }

  /**
   * Snapshot — returns a fresh object with all series materialized.
   * Callers may freely mutate the returned object; it does not alias
   * the registry's internal state.
   */
  getMetrics(): MetricsSnapshot {
    const counters: CounterSnapshot[] = [];
    for (const [name, series] of this.counterSeries.entries()) {
      for (const { metric, labels } of series.values()) {
        counters.push({ name, labels: { ...labels }, value: metric.value() });
      }
    }
    const histograms: HistogramSnapshot[] = [];
    for (const [name, series] of this.histogramSeries.entries()) {
      for (const { metric, labels } of series.values()) {
        const snap = metric.snapshot();
        histograms.push({ ...snap, name, labels: { ...labels } });
      }
    }
    const gauges: GaugeSnapshot[] = [];
    for (const [name, series] of this.gaugeSeries.entries()) {
      for (const { metric, labels } of series.values()) {
        gauges.push({ name, labels: { ...labels }, value: metric.value() });
      }
    }
    return {
      counters,
      histograms,
      gauges,
      uptime_s: Math.floor((Date.now() - MODULE_STARTED_AT) / 1000),
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /** Test-only: drop all series. Production code never calls this. */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
    this.counterSeries.clear();
    this.histogramSeries.clear();
    this.gaugeSeries.clear();
  }

  private getOrCreateCounter(name: string, labels: LabelSet): Counter {
    let byName = this.counterSeries.get(name);
    if (!byName) {
      byName = new Map();
      this.counterSeries.set(name, byName);
    }
    const key = labelKey(labels);
    let entry = byName.get(key);
    if (!entry) {
      const metric = new Counter(name);
      this.counters.set(`${name}\x00${key}`, metric);
      entry = { metric, labels };
      byName.set(key, entry);
    }
    return entry.metric;
  }

  private getOrCreateHistogram(name: string, labels: LabelSet): Histogram {
    let byName = this.histogramSeries.get(name);
    if (!byName) {
      byName = new Map();
      this.histogramSeries.set(name, byName);
    }
    const key = labelKey(labels);
    let entry = byName.get(key);
    if (!entry) {
      const metric = new Histogram(name);
      this.histograms.set(`${name}\x00${key}`, metric);
      entry = { metric, labels };
      byName.set(key, entry);
    }
    return entry.metric;
  }

  private getOrCreateGauge(name: string, labels: LabelSet): Gauge {
    let byName = this.gaugeSeries.get(name);
    if (!byName) {
      byName = new Map();
      this.gaugeSeries.set(name, byName);
    }
    const key = labelKey(labels);
    let entry = byName.get(key);
    if (!entry) {
      const metric = new Gauge(name);
      this.gauges.set(`${name}\x00${key}`, metric);
      entry = { metric, labels };
      byName.set(key, entry);
    }
    return entry.metric;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + feature flag
// ---------------------------------------------------------------------------

const MODULE_STARTED_AT = Date.now();

const globalRegistry = new MetricsRegistry();

let metricsEnabledFlag = false;

export function getMetricsEnabled(): boolean {
  return metricsEnabledFlag;
}

export function setMetricsEnabled(enabled: boolean): void {
  metricsEnabledFlag = enabled;
}

/** Test-only: drop all series + reset the flag to false. */
export function resetForTest(): void {
  globalRegistry.reset();
  metricsEnabledFlag = false;
}

// ---------------------------------------------------------------------------
// Module-level helpers (no-ops when disabled)
// ---------------------------------------------------------------------------

/**
 * Increment a counter. Module-level helper, no-op when metrics is
 * disabled. Defaults to +1; pass a third argument for a different
 * increment (e.g. to record a per-batch count).
 */
export function incCounter(
  name: string,
  labels?: LabelSet,
  value: number = 1,
): void {
  if (!metricsEnabledFlag) return;
  globalRegistry.incCounter(name, labels, value);
}

/** Record a histogram observation (typically a duration in ms). */
export function observe(
  name: string,
  valueMs: number,
  labels?: LabelSet,
): void {
  if (!metricsEnabledFlag) return;
  globalRegistry.observe(name, valueMs, labels);
}

/** Set a gauge to an absolute value. */
export function setGauge(
  name: string,
  value: number,
  labels?: LabelSet,
): void {
  if (!metricsEnabledFlag) return;
  globalRegistry.setGauge(name, value, labels);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * HTTP handler for /api/xiaozhi/metrics.
 *
 * When metrics is enabled: returns a 200 with the JSON snapshot.
 * When disabled: returns 404 (the route is effectively unmounted
 * from the public surface).
 *
 * Registered in src/register.ts (plugin-level, auth: "plugin") and
 * also dispatched by src/gateway.ts's HTTP server for the same path
 * (in case the plugin api route is unavailable in some test harnesses).
 */
export async function metricsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!metricsEnabledFlag) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("");
    return;
  }
  const snap = globalRegistry.getMetrics();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(snap));
}
