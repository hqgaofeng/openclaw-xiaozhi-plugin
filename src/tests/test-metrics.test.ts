/**
 * Metrics module tests — v0.4.0-rc2 (batch 2).
 *
 * Covers:
 *   - Counter / Histogram / Gauge primitive types
 *   - MetricsRegistry singleton isolation (label sets don't collide)
 *   - Histogram percentile math (p50/p95/p99 on fixed dataset)
 *   - Module-level helpers (`incCounter` / `observe` / `setGauge`)
 *   - Feature gate: disabled → no-ops, /metrics 404
 *   - Feature gate: enabled → JSON snapshot via metricsHandler
 *   - Disabled helpers don't allocate / don't throw
 *
 * The module exposes a singleton registry with a `resetForTest()` hook
 * so each test starts from a clean slate. The feature flag is also
 * resettable via setMetricsEnabled().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Counter,
  Histogram,
  Gauge,
  MetricsRegistry,
  incCounter,
  observe,
  setGauge,
  metricsHandler,
  setMetricsEnabled,
  getMetricsEnabled,
  resetForTest,
  type MetricsSnapshot,
} from "../metrics.js";

interface MockRes extends ServerResponse {
  _body: string;
  _status: number;
  _headers: Record<string, string>;
}

function makeRes(): MockRes {
  const res = {
    _body: "",
    _status: 0,
    _headers: {},
    statusCode: 0,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return this._headers[name.toLowerCase()];
    },
    end(chunk?: string) {
      if (chunk) this._body += chunk;
      this._status = this.statusCode;
    },
    destroy() {},
  } as unknown as MockRes;
  return res;
}

function makeReq(method: string = "GET"): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  process.nextTick(() => {
    (req as unknown as PassThrough).end();
  });
  return req;
}

/** Run metricsHandler with a one-shot mock and return the parsed JSON body. */
async function exportSnapshot(): Promise<MetricsSnapshot> {
  const req = makeReq();
  const res = makeRes();
  await metricsHandler(req, res);
  if (res._status !== 200) {
    throw new Error(
      `metricsHandler returned ${res._status} (body=${res._body.slice(0, 80)})`,
    );
  }
  return JSON.parse(res._body) as MetricsSnapshot;
}

beforeEach(() => {
  resetForTest();
  setMetricsEnabled(false);
});

describe("Counter primitive", () => {
  it("starts at 0 and increments by 1 by default", () => {
    const c = new Counter("test_counter_a");
    expect(c.value()).toBe(0);
    c.inc();
    c.inc();
    c.inc();
    expect(c.value()).toBe(3);
  });

  it("increments by an explicit value (including fractional)", () => {
    const c = new Counter("test_counter_b");
    c.inc(5);
    c.inc(2.5);
    expect(c.value()).toBe(7.5);
  });
});

describe("Histogram primitive", () => {
  it("observe + percentile math on a fixed dataset (1..100)", () => {
    const h = new Histogram("test_hist_a");
    for (let i = 1; i <= 100; i++) h.observe(i);
    const s = h.snapshot();
    expect(s.count).toBe(100);
    expect(s.sum).toBe(5050);
    expect(s.avg).toBe(50.5);
    // Nearest-rank percentile: p50 of 1..100 → element at rank 50 = 50
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });

  it("empty histogram → count=0, sum=0, percentiles=0", () => {
    const h = new Histogram("test_hist_b");
    const s = h.snapshot();
    expect(s.count).toBe(0);
    expect(s.sum).toBe(0);
    expect(s.avg).toBe(0);
    expect(s.p50).toBe(0);
    expect(s.p95).toBe(0);
    expect(s.p99).toBe(0);
  });

  it("single observation → all percentiles = that value", () => {
    const h = new Histogram("test_hist_c");
    h.observe(42);
    const s = h.snapshot();
    expect(s.count).toBe(1);
    expect(s.sum).toBe(42);
    expect(s.avg).toBe(42);
    expect(s.p50).toBe(42);
    expect(s.p95).toBe(42);
    expect(s.p99).toBe(42);
  });
});

describe("Gauge primitive", () => {
  it("set overwrites the value", () => {
    const g = new Gauge("test_gauge_a");
    g.set(10);
    g.set(20);
    expect(g.value()).toBe(20);
  });

  it("inc / dec produce deltas", () => {
    const g = new Gauge("test_gauge_b");
    g.set(5);
    g.inc();
    g.inc(2);
    g.dec();
    expect(g.value()).toBe(7);
  });
});

describe("MetricsRegistry isolation", () => {
  it("same name + different labels → distinct series", () => {
    const r = new MetricsRegistry();
    r.incCounter("foo", { device: "a" });
    r.incCounter("foo", { device: "a" });
    r.incCounter("foo", { device: "b" });
    const snap = r.getMetrics();
    const foos = snap.counters.filter((c) => c.name === "foo");
    expect(foos).toHaveLength(2);
    const a = foos.find((c) => c.labels.device === "a");
    const b = foos.find((c) => c.labels.device === "b");
    expect(a?.value).toBe(2);
    expect(b?.value).toBe(1);
  });

  it("snapshot returns defensively-copied data", () => {
    const r = new MetricsRegistry();
    r.incCounter("x", { tag: "1" });
    const snap = r.getMetrics();
    // Mutate the snapshot — the next snapshot must be unchanged.
    snap.counters[0].value = 9999;
    const snap2 = r.getMetrics();
    expect(snap2.counters[0].value).toBe(1);
  });

  it("label ordering does not produce duplicate series", () => {
    const r = new MetricsRegistry();
    r.incCounter("y", { a: "1", b: "2" });
    r.incCounter("y", { b: "2", a: "1" });
    const snap = r.getMetrics();
    expect(snap.counters.filter((c) => c.name === "y")).toHaveLength(1);
    expect(snap.counters[0].value).toBe(2);
  });
});

describe("Module-level helpers: enabled path", () => {
  beforeEach(() => {
    setMetricsEnabled(true);
  });

  it("incCounter bumps the right series with default value 1", async () => {
    incCounter("mod_counter", { device: "esp32-1" });
    incCounter("mod_counter", { device: "esp32-1" });
    incCounter("mod_counter", { device: "esp32-1" }, 5);
    const snap = await exportSnapshot();
    const c = snap.counters.find(
      (x) => x.name === "mod_counter" && x.labels.device === "esp32-1",
    );
    expect(c?.value).toBe(7);
  });

  it("observe records a histogram sample", async () => {
    observe("mod_hist", 100, { kind: "asr" });
    observe("mod_hist", 200, { kind: "asr" });
    observe("mod_hist", 300, { kind: "asr" });
    const snap = await exportSnapshot();
    const h = snap.histograms.find(
      (x) => x.name === "mod_hist" && x.labels.kind === "asr",
    );
    expect(h?.count).toBe(3);
    expect(h?.sum).toBe(600);
    expect(h?.avg).toBe(200);
  });

  it("setGauge writes a value", async () => {
    setGauge("mod_gauge", 7, { scope: "global" });
    const snap = await exportSnapshot();
    const g = snap.gauges.find(
      (x) => x.name === "mod_gauge" && x.labels.scope === "global",
    );
    expect(g?.value).toBe(7);
  });

  it("getMetricsEnabled reflects setMetricsEnabled", () => {
    expect(getMetricsEnabled()).toBe(true);
    setMetricsEnabled(false);
    expect(getMetricsEnabled()).toBe(false);
  });
});

describe("Module-level helpers: disabled path (no-op)", () => {
  it("incCounter is a no-op when disabled (does not throw, does not allocate a series)", async () => {
    expect(() => incCounter("noop_counter", { device: "x" })).not.toThrow();
    expect(() => incCounter("noop_counter", { device: "x" }, 100)).not.toThrow();
    setMetricsEnabled(true);
    const snap = await exportSnapshot();
    expect(snap.counters.find((c) => c.name === "noop_counter")).toBeUndefined();
    setMetricsEnabled(false);
  });

  it("observe is a no-op when disabled", async () => {
    expect(() => observe("noop_hist", 42, { x: "y" })).not.toThrow();
    setMetricsEnabled(true);
    const snap = await exportSnapshot();
    expect(snap.histograms.find((h) => h.name === "noop_hist")).toBeUndefined();
    setMetricsEnabled(false);
  });

  it("setGauge is a no-op when disabled", async () => {
    expect(() => setGauge("noop_gauge", 999, { x: "y" })).not.toThrow();
    setMetricsEnabled(true);
    const snap = await exportSnapshot();
    expect(snap.gauges.find((g) => g.name === "noop_gauge")).toBeUndefined();
    setMetricsEnabled(false);
  });
});

describe("metricsHandler", () => {
  it("disabled → 404 with empty body", async () => {
    const req = makeReq();
    const res = makeRes();
    await metricsHandler(req, res);
    expect(res._status).toBe(404);
    expect(res._body).toBe("");
  });

  it("enabled → 200 with correct JSON shape", async () => {
    setMetricsEnabled(true);
    incCounter("handler_test_counter", { device: "a" }, 3);
    observe("handler_test_hist", 100, { kind: "x" });
    observe("handler_test_hist", 300, { kind: "x" });
    setGauge("handler_test_gauge", 42, { scope: "y" });

    const req = makeReq();
    const res = makeRes();
    await metricsHandler(req, res);

    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toMatch(/application\/json/);
    const body = JSON.parse(res._body) as MetricsSnapshot;
    expect(body).toHaveProperty("counters");
    expect(body).toHaveProperty("histograms");
    expect(body).toHaveProperty("gauges");
    expect(body).toHaveProperty("uptime_s");
    expect(body).toHaveProperty("timestamp");
    expect(typeof body.uptime_s).toBe("number");
    expect(typeof body.timestamp).toBe("number");
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);

    const c = body.counters.find(
      (x) => x.name === "handler_test_counter" && x.labels.device === "a",
    );
    expect(c?.value).toBe(3);

    const h = body.histograms.find(
      (x) => x.name === "handler_test_hist" && x.labels.kind === "x",
    );
    expect(h?.count).toBe(2);
    expect(h?.sum).toBe(400);
    expect(h?.avg).toBe(200);
    expect(h?.p50).toBe(100);
    expect(h?.p95).toBe(300);
    expect(h?.p99).toBe(300);

    const g = body.gauges.find(
      (x) => x.name === "handler_test_gauge" && x.labels.scope === "y",
    );
    expect(g?.value).toBe(42);
  });

  it("does not log warnings during normal handler invocation", async () => {
    setMetricsEnabled(true);
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = makeReq();
    const res = makeRes();
    await metricsHandler(req, res);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
