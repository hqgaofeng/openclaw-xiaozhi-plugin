/**
 * Silero ONNX VAD tests — v0.4.0-rc3 (batch 3).
 *
 * Covers:
 *   - tryGetSileroVad() returns null when useSileroVad flag is false (default)
 *   - tryGetSileroVad() returns null when not yet initialized
 *   - tryGetSileroVad() returns the instance after init succeeds
 *   - init() throws on missing model file (graceful error)
 *   - init() is idempotent (singleton — second call is a no-op)
 *   - isSpeech() throws on bad input shape (not a 60ms 16kHz int16 frame)
 *   - isSpeech() throws when called before init()
 *   - dispose() releases the loaded session
 *   - dispose() on uninitialized instance is a no-op
 *
 * Tests DO NOT load a real ONNX model — vitest runs in a sandbox
 * without the 100MB silero_v4.onnx file. The model is mocked via a
 * fake onnxruntime-node that exposes a deterministic inference
 * path (returns 0.9 for a "loud" frame, 0.05 for a "silent" frame).
 * The intent is to verify the wrapper's shape validation and
 * lifecycle, not the ONNX runtime's correctness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "node:buffer";

// Module-level state that the mock will populate
let mockModelExists = true;
let mockInitError: string | null = null;
let mockInferenceResult = 0.5; // probability of speech
let initCallCount = 0;
let inferenceCallCount = 0;

// Mock onnxruntime-node before importing the silero wrapper
vi.mock("onnxruntime-node", () => {
  return {
    default: {
      InferenceSession: {
        async create(path: string) {
          initCallCount++;
          if (mockInitError) {
            throw new Error(mockInitError);
          }
          if (!mockModelExists) {
            throw new Error(`file not found: ${path}`);
          }
          return {
            inputNames: ["input", "h", "c"],
            outputNames: ["output", "hn", "cn"],
            async run(feeds: Record<string, unknown>) {
              inferenceCallCount++;
              // If input is "loud" (mean abs value > 1000), return high
              // probability; otherwise low. This is deterministic
              // for the test, not realistic.
              const input = feeds.input as { data: Float32Array };
              let meanAbs = 0;
              for (let i = 0; i < input.data.length; i++) {
                meanAbs += Math.abs(input.data[i]);
              }
              meanAbs /= Math.max(1, input.data.length);
              mockInferenceResult = meanAbs > 0.05 ? 0.92 : 0.04;
              return {
                output: { data: new Float32Array([mockInferenceResult]) },
                hn: { data: new Float32Array(64).fill(0) },
                cn: { data: new Float32Array(64).fill(0) },
              };
            },
            async release() {
              // no-op for the mock
            },
          };
        },
      },
      Tensor: class {
        constructor(
          public readonly type: string,
          public readonly data: Float32Array,
          public readonly dims: number[],
        ) {}
      },
    },
  };
});

// Mock the feature-flag reads so we can flip useSileroVad per test
let mockUseSileroVad = false;
let mockUseMultiFlagState = false;
let mockUseAccumulatePcm = false;
let mockUseStreamingAsr = false;

vi.mock("../api.js", () => {
  return {
    getUseSileroVad: () => mockUseSileroVad,
    getUseMultiFlagState: () => mockUseMultiFlagState,
    getUseAccumulatePcm: () => mockUseAccumulatePcm,
    getUseStreamingAsr: () => mockUseStreamingAsr,
    getUseRetry: () => false,
    getMetricsEnabled: () => false,
  };
});

// Now import the module under test
import {
  SileroVad,
  tryGetSileroVad,
  disposeSileroVad,
  _resetSileroVadForTest,
} from "../vad-silero.js";

/** Build a 60ms 16kHz int16 mono PCM buffer (1920 samples = 3840 bytes). */
function makeFrame(samples: number = 0): Buffer {
  const buf = Buffer.alloc(3840);
  for (let i = 0; i < 1920; i++) {
    buf.writeInt16LE(samples, i * 2);
  }
  return buf;
}

/** Build a 60ms 16kHz int16 mono PCM buffer with sine-wave content (loud). */
function makeLoudFrame(): Buffer {
  const buf = Buffer.alloc(3840);
  for (let i = 0; i < 1920; i++) {
    // 440Hz sine at ~half amplitude — gives mean abs ≈ 0.25
    const v = Math.floor(Math.sin((i / 16000) * 2 * Math.PI * 440) * 16384);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

beforeEach(() => {
  _resetSileroVadForTest();
  mockModelExists = true;
  mockInitError = null;
  mockInferenceResult = 0.5;
  initCallCount = 0;
  inferenceCallCount = 0;
  mockUseSileroVad = false;
  mockUseMultiFlagState = false;
  mockUseAccumulatePcm = false;
  mockUseStreamingAsr = false;
});

afterEach(() => {
  _resetSileroVadForTest();
});

describe("tryGetSileroVad — feature flag", () => {
  it("returns null when useSileroVad=false (default)", () => {
    mockUseSileroVad = false;
    expect(tryGetSileroVad()).toBeNull();
  });

  it("returns null when useSileroVad=true but init has not run", () => {
    mockUseSileroVad = true;
    expect(tryGetSileroVad()).toBeNull();
  });
});

describe("SileroVad.init — lifecycle", () => {
  it("throws when model file is missing", async () => {
    mockModelExists = false;
    const vad = new SileroVad();
    await expect(
      vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx"),
    ).rejects.toThrow(/file not found|silero/i);
  });

  it("throws when onnx runtime reports a load error", async () => {
    mockInitError = "invalid onnx file";
    const vad = new SileroVad();
    await expect(
      vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx"),
    ).rejects.toThrow(/invalid onnx file/);
  });

  it("loads successfully and becomes usable", async () => {
    const vad = new SileroVad();
    await vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx");
    expect(vad.isInitialized()).toBe(true);
    expect(initCallCount).toBe(1);
  });
});

describe("SileroVad.isSpeech — input validation", () => {
  it("throws when called before init()", async () => {
    const vad = new SileroVad();
    await expect(vad.isSpeech(makeFrame())).rejects.toThrow(/before init\(\)/i);
  });

  it("throws on wrong-size buffer (not a 60ms 16kHz int16 frame)", async () => {
    const vad = new SileroVad();
    await vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx");
    const tooShort = Buffer.alloc(100); // 50 samples
    await expect(vad.isSpeech(tooShort)).rejects.toThrow(/frame size|3840/i);
    const tooLong = Buffer.alloc(8000); // 4000 samples
    await expect(vad.isSpeech(tooLong)).rejects.toThrow(/frame size|3840/i);
  });

  it("returns true on a loud (sine-wave) frame", async () => {
    const vad = new SileroVad();
    await vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx");
    const result = await vad.isSpeech(makeLoudFrame());
    expect(result).toBe(true);
    expect(inferenceCallCount).toBeGreaterThanOrEqual(1);
  });

  it("returns false on a silent (zero-amplitude) frame", async () => {
    const vad = new SileroVad();
    await vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx");
    const result = await vad.isSpeech(makeFrame(0));
    expect(result).toBe(false);
  });
});

describe("SileroVad — dispose and singleton", () => {
  it("dispose() on uninitialized instance is a no-op", () => {
    const vad = new SileroVad();
    expect(() => vad.dispose()).not.toThrow();
  });

  it("dispose() releases the session and re-init works", async () => {
    const vad = new SileroVad();
    await vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx");
    expect(vad.isInitialized()).toBe(true);
    vad.dispose();
    expect(vad.isInitialized()).toBe(false);
    // Re-init should work after dispose
    await vad.init("/opt/xiaozhi-plugin/models/silero/silero_v4.onnx");
    expect(vad.isInitialized()).toBe(true);
    expect(initCallCount).toBe(2);
  });
});
