/**
 * Silero ONNX v4 VAD wrapper — v0.4.0-rc3 (batch 3).
 *
 * Mirrors the role of the official xiaozhi-esp32-server
 * (core/providers/vad/silero.py) but in Node + onnxruntime-node.
 * Lazy-loads the ONNX runtime and model on first use to keep
 * plugin startup fast. Singleton — the model is loaded once and
 * reused across all sessions.
 *
 * ## Resource budget
 *
 *   - silero_v4.onnx: ~100MB model file at /opt/xiaozhi-plugin/models/silero/
 *   - onnxruntime-node: ~50MB native binding (added as an explicit dep)
 *
 *   These are NOT bundled with the npm package — the model is downloaded
 *   to /opt/xiaozhi-plugin/models/silero/ via a VPS prod step (V3 docs).
 *
 * ## Grayscale gate
 *
 *   useSileroVad=false (default): tryGetSileroVad() returns null, every
 *   call site falls back to the existing RMS-based vad.ts. The ONNX
 *   runtime is NOT imported.
 *
 *   useSileroVad=true: tryGetSileroVad() returns the singleton after the
 *   first init() resolves. onnxruntime-node is loaded via dynamic import
 *   so the dep is invisible to anything that doesn't flip the flag.
 *
 * ## Silero V4 API
 *
 *   Input:  float32 PCM, 16kHz mono, 512 samples per window.
 *   Output: { output: speech_prob, hn: float[2*1*64], cn: float[2*1*64] }
 *
 *   The state (hn, cn) is fed back on the next call. A 60ms esp32 frame
 *   (1920 samples @ 16kHz) is chunked into 3 full 512-sample windows
 *   plus 384 leftover samples (carried over to the next frame).
 *
 * ## Async inference
 *
 *   onnxruntime-node's session.run() returns a Promise. We expose an
 *   async isSpeechAsync() so callers can await the full inference
 *   result. The VAD watcher (vad.ts) awaits this once per 60ms frame
 *   — that's ~3 inferences per frame × 17 frames/sec = ~50/sec, well
 *   within onnxruntime-node's throughput.
 */

import { Buffer } from "node:buffer";
import { getUseSileroVad, getMetricsEnabled } from "./api.js";
import { observe as observeMetric } from "./metrics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One 60ms esp32 frame at 16kHz mono int16. */
const FRAME_SAMPLES = 1920;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Silero V4 expected window size. */
const SILERO_WINDOW_SAMPLES = 512;
/** Probability threshold above which we declare "speech". */
const SILERO_SPEECH_THRESHOLD = 0.5;
/** Default model path on the VPS. Override at init() time. */
export const DEFAULT_SILERO_MODEL_PATH =
  "/opt/xiaozhi-plugin/models/silero/silero_v4.onnx";

// ---------------------------------------------------------------------------
// ONNX runtime types — minimal shape we need
// ---------------------------------------------------------------------------

/** Subset of the onnxruntime-node Tensor type. */
interface OrtTensor {
  type: string;
  data: Float32Array;
  dims: readonly number[];
}

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}

interface OrtModule {
  InferenceSession: {
    create(path: string): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: readonly number[],
  ) => OrtTensor;
}

let _ort: OrtModule | null = null;
/**
 * Dynamic import — onnxruntime-node is a native binding, so we
 * load it lazily. If the binary is missing or the platform is
 * unsupported, this throws and we surface a clear error.
 */
async function loadOrt(): Promise<OrtModule> {
  if (_ort) return _ort;
  try {
    const moduleName = "onnxruntime-node";
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      default?: OrtModule;
    } & OrtModule;
    const ort = (mod.default ?? mod) as OrtModule;
    _ort = ort;
    return ort;
  } catch (err) {
    throw new Error(
      `Silero VAD: failed to load onnxruntime-node: ${(err as Error).message}. ` +
      `Install with: npm install onnxruntime-node`,
    );
  }
}

// ---------------------------------------------------------------------------
// SileroVad class
// ---------------------------------------------------------------------------

export class SileroVad {
  private session: OrtSession | null = null;
  private modelPath: string = DEFAULT_SILERO_MODEL_PATH;
  /** Rolling state across 512-sample windows. */
  private hn: Float32Array = new Float32Array(2 * 1 * 64);
  private cn: Float32Array = new Float32Array(2 * 1 * 64);
  /** Carry-over samples between calls. */
  private carry: Float32Array = new Float32Array(0);
  private _initialized = false;

  /** Returns true once init() has succeeded. */
  isInitialized(): boolean {
    return this._initialized;
  }

  /** Returns the model path that was passed to init(). */
  getModelPath(): string {
    return this.modelPath;
  }

  /**
   * Load the ONNX model. Throws on any error (file missing, invalid
   * file, platform unsupported). Idempotent — second call with the
   * same path is a no-op; different path releases + reloads.
   */
  async init(modelPath: string = DEFAULT_SILERO_MODEL_PATH): Promise<void> {
    if (this._initialized && this.modelPath === modelPath) return;
    this.dispose(); // free any previous session
    this.modelPath = modelPath;
    const ort = await loadOrt();
    const session = await ort.InferenceSession.create(modelPath);
    this.session = session;
    this.hn = new Float32Array(2 * 1 * 64);
    this.cn = new Float32Array(2 * 1 * 64);
    this.carry = new Float32Array(0);
    this._initialized = true;
  }

  /**
   * Run VAD on a 60ms int16 PCM frame (1920 samples @ 16kHz).
   * Returns a Promise<boolean> — true if any 512-sample window in
   * the frame was classified as speech.
   *
   * Throws on bad input shape or if init() has not been called.
   */
  async isSpeech(pcmInt16: Buffer): Promise<boolean> {
    if (!this._initialized || !this.session) {
      throw new Error(
        "SileroVad.isSpeech() called before init() — call awaitEnsureSileroVad() first",
      );
    }
    if (pcmInt16.length !== FRAME_BYTES) {
      throw new Error(
        `SileroVad: expected ${FRAME_BYTES}-byte 60ms 16kHz int16 frame, ` +
        `got ${pcmInt16.length} bytes`,
      );
    }
    const start = Date.now();
    const samples = int16ToFloat32(pcmInt16);

    // Concatenate carry + new samples
    const total = new Float32Array(this.carry.length + samples.length);
    total.set(this.carry, 0);
    total.set(samples, this.carry.length);

    let anySpeech = false;
    let windowsProcessed = 0;
    let i = 0;
    for (; i + SILERO_WINDOW_SAMPLES <= total.length; i += SILERO_WINDOW_SAMPLES) {
      const window = total.subarray(i, i + SILERO_WINDOW_SAMPLES);
      const prob = await this.runWindow(window);
      windowsProcessed++;
      if (prob >= SILERO_SPEECH_THRESHOLD) {
        anySpeech = true;
      }
    }
    // Save leftover samples for next call
    if (i < total.length) {
      this.carry = total.subarray(i);
    } else {
      this.carry = new Float32Array(0);
    }

    if (getMetricsEnabled()) {
      observeMetric(
        "xiaozhi_vad_silero_inference_ms",
        Date.now() - start,
        { windows: String(windowsProcessed) },
      );
    }
    return anySpeech;
  }

  /**
   * Synchronous-ish check that returns the cached result of the
   * last isSpeech() call. Returns null if no inference has run yet.
   * Useful for callers that don't want to await (e.g. metrics
   * dashboards) — not used by the production VAD watcher.
   */
  getLastResult(): { speech: boolean; prob: number } | null {
    return this._lastResult;
  }

  /** Free the ONNX session. Idempotent. */
  dispose(): void {
    if (this.session) {
      // session.release() is async; we don't await — best-effort cleanup.
      void this.session.release().catch(() => {});
      this.session = null;
    }
    this._initialized = false;
    this.hn = new Float32Array(2 * 1 * 64);
    this.cn = new Float32Array(2 * 1 * 64);
    this.carry = new Float32Array(0);
    this._lastResult = null;
  }

  // --- private ---

  private _lastResult: { speech: boolean; prob: number } | null = null;

  private async runWindow(samples: Float32Array): Promise<number> {
    const session = this.session;
    const ort = _ort;
    if (!session || !ort) return 0;
    const inputTensor = new ort.Tensor("float32", samples, [1, SILERO_WINDOW_SAMPLES]);
    const hTensor = new ort.Tensor("float32", this.hn, [2, 1, 64]);
    const cTensor = new ort.Tensor("float32", this.cn, [2, 1, 64]);
    const feeds: Record<string, OrtTensor> = {
      [session.inputNames[0] ?? "input"]: inputTensor,
      [session.inputNames[1] ?? "h"]: hTensor,
      [session.inputNames[2] ?? "c"]: cTensor,
    };
    let out: Record<string, OrtTensor>;
    try {
      out = await session.run(feeds);
    } catch {
      return 0;
    }
    const prob = (out[session.outputNames[0] ?? "output"]?.data?.[0] ?? 0) as number;
    const hnOut = out[session.outputNames[1] ?? "hn"]?.data;
    const cnOut = out[session.outputNames[2] ?? "cn"]?.data;
    if (hnOut) this.hn = new Float32Array(hnOut);
    if (cnOut) this.cn = new Float32Array(cnOut);
    this._lastResult = { speech: prob >= SILERO_SPEECH_THRESHOLD, prob };
    return prob;
  }
}

// ---------------------------------------------------------------------------
// Singleton + gate
// ---------------------------------------------------------------------------

let _singleton: SileroVad | null = null;
let _initPromise: Promise<SileroVad> | null = null;

/**
 * Returns the singleton SileroVad instance if (a) useSileroVad flag is
 * true AND (b) init() has resolved. Otherwise returns null.
 *
 * Callers MUST handle the null case by falling back to RMS-based VAD.
 * The singleton is lazy — the ONNX runtime is NOT imported until
 * init() is called via the first awaitEnsureSileroVad().
 */
export function tryGetSileroVad(): SileroVad | null {
  if (!getUseSileroVad()) return null;
  if (!_singleton || !_singleton.isInitialized()) return null;
  return _singleton;
}

/**
 * Ensure the SileroVad singleton is loaded. If useSileroVad is false,
 * returns null. Otherwise resolves with the loaded instance.
 *
 * Concurrent calls share the same init promise (singleton pattern).
 */
export async function awaitEnsureSileroVad(
  modelPath: string = DEFAULT_SILERO_MODEL_PATH,
): Promise<SileroVad | null> {
  if (!getUseSileroVad()) return null;
  if (_singleton && _singleton.isInitialized() && _singleton.getModelPath() === modelPath) {
    return _singleton;
  }
  if (_initPromise) return _initPromise;
  const instance = _singleton ?? new SileroVad();
  _singleton = instance;
  _initPromise = instance.init(modelPath).then(() => instance);
  try {
    return await _initPromise;
  } catch (err) {
    // Reset the promise so a future call can retry.
    _initPromise = null;
    throw err;
  }
}

/** Release the singleton. Test-only. */
export function disposeSileroVad(): void {
  if (_singleton) {
    _singleton.dispose();
    _singleton = null;
  }
  _initPromise = null;
}

/** Test-only: drop the singleton entirely. */
export function _resetSileroVadForTest(): void {
  disposeSileroVad();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert PCM int16 little-endian to Float32Array in [-1, 1]. */
export function int16ToFloat32(pcm: Buffer): Float32Array {
  const samples = pcm.length / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}
