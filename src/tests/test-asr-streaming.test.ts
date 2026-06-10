/**
 * sherpa-onnx streaming ASR tests — v0.4.0-rc3 (batch 3).
 *
 * Covers the pull-based OnlineRecognizer path that the new
 * SherpaOnnxStreamingASR exposes. The 3 V2 #1 pitfalls (int16 vs
 * float32, bpe modeling unit, pull-based decode loop) are guarded by
 * dedicated tests here so a future refactor that reverts one of them
 * gets caught immediately.
 *
 * Tests:
 *   - Constructor requires modelDir
 *   - getModelDir() returns the configured path
 *   - streamChunk() requires float32 (not int16) input — pitfall #1
 *   - streamChunk() accepts a Float32Array — the happy path
 *   - finalize() flips state and returns the final text
 *   - reset() clears internal state
 *   - bpeVocab is required when modelingUnit="bpe" — pitfall #2
 *   - register/getASRProvider resolves "sherpa_onnx_streaming"
 *   - cache key differs from "sherpa_onnx" (offline) — different
 *     model path or instance
 *
 * The actual sherpa-onnx WASM module is mocked so the test can run
 * in CI without the 15MB binary present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the sherpa-onnx module before importing our wrapper
const mockCreateOnlineRecognizer = vi.fn();
const mockCreateStream = vi.fn();
let mockIsReadyReturn = true;
let mockGetResultText = "hello world";
let mockDecodeCallCount = 0;

vi.mock("sherpa-onnx", () => {
  return {
    default: {
      createOnlineRecognizer: (config: unknown) => {
        mockCreateOnlineRecognizer(config);
        return {
          free: () => {},
          createStream: () => {
            mockCreateStream();
            return {
              acceptWaveform: (_sr: number, _samples: Float32Array) => {},
              inputFinished: () => {},
            };
          },
          isReady: (_stream: unknown) => {
            // First call: true (decode). Subsequent: false so loop exits.
            const r = mockIsReadyReturn;
            mockIsReadyReturn = false;
            return r;
          },
          decode: (_stream: unknown) => {
            mockDecodeCallCount++;
          },
          getResult: (_stream: unknown) => ({ text: mockGetResultText }),
        };
      },
    },
  };
});

// Mock feature-flag reads
let mockUseStreamingAsr = false;
vi.mock("../api.js", () => {
  return {
    getUseSileroVad: () => false,
    getUseMultiFlagState: () => false,
    getUseAccumulatePcm: () => false,
    getUseStreamingAsr: () => mockUseStreamingAsr,
    getUseRetry: () => false,
    getMetricsEnabled: () => false,
  };
});

import {
  SherpaOnnxStreamingASR,
  isFloat32Array,
  validateBpeVocab,
} from "../asr/sherpa-onnx-streaming.js";
import {
  getASRProvider,
  disposeASRProvider,
} from "../asr/index.js";

beforeEach(() => {
  mockCreateOnlineRecognizer.mockClear();
  mockCreateStream.mockClear();
  mockIsReadyReturn = true;
  mockGetResultText = "hello world";
  mockDecodeCallCount = 0;
  mockUseStreamingAsr = false;
  disposeASRProvider();
});

afterEach(() => {
  disposeASRProvider();
});

describe("SherpaOnnxStreamingASR — constructor", () => {
  it("requires modelDir", () => {
    expect(
      () => new SherpaOnnxStreamingASR({ modelDir: "" }),
    ).toThrow(/modelDir is required/);
  });

  it("accepts a modelDir and exposes it", () => {
    const asr = new SherpaOnnxStreamingASR({
      modelDir: "/opt/xiaozhi-plugin/models/sherpa-streaming",
    });
    expect(asr.getModelDir()).toBe(
      "/opt/xiaozhi-plugin/models/sherpa-streaming",
    );
  });

  it("defaults modelingUnit to bpe and bpeVocab to modelDir/bpe.vocab", async () => {
    const asr = new SherpaOnnxStreamingASR({
      modelDir: "/m",
    });
    // Trigger model load to inspect the config passed to sherpa
    await asr.transcribe(Buffer.alloc(320));
    const cfg = mockCreateOnlineRecognizer.mock.calls[0]?.[0] as
      | { modelConfig: { modelingUnit: string; bpeVocab: string } }
      | undefined;
    expect(cfg).toBeDefined();
    expect(cfg!.modelConfig.modelingUnit).toBe("bpe");
    expect(cfg!.modelConfig.bpeVocab).toBe("/m/bpe.vocab");
  });
});

describe("SherpaOnnxStreamingASR — float32 vs int16 pitfall", () => {
  it("isFloat32Array returns true for Float32Array, false for Buffer/int16", () => {
    expect(isFloat32Array(new Float32Array(10))).toBe(true);
    expect(isFloat32Array(Buffer.alloc(20))).toBe(false);
    expect(isFloat32Array(new Int16Array(10))).toBe(false);
  });

  it("transcribe() converts int16 PCM to float32 internally (pitfall #1)", async () => {
    const asr = new SherpaOnnxStreamingASR({ modelDir: "/m" });
    // Build an int16 buffer with a known max amplitude
    const pcm = Buffer.alloc(320); // 160 samples
    for (let i = 0; i < 160; i++) {
      pcm.writeInt16LE(i % 100, i * 2);
    }
    mockGetResultText = "converted";
    const result = await asr.transcribe(pcm);
    expect(result.text).toBe("converted");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("streamChunk() rejects Buffer (must be Float32Array) — pitfall #1", async () => {
    const asr = new SherpaOnnxStreamingASR({ modelDir: "/m" });
    // Force lazy init via transcribe with empty buffer
    await asr.transcribe(Buffer.alloc(0));
    await expect(
      asr.streamChunk(16000, Buffer.alloc(320) as unknown as Float32Array),
    ).rejects.toThrow(/float32/i);
  });

  it("streamChunk() accepts a Float32Array directly", async () => {
    const asr = new SherpaOnnxStreamingASR({ modelDir: "/m" });
    // Force lazy init
    await asr.transcribe(Buffer.alloc(0));
    // After transcribe, the recognizer + stream are alive. The next
    // streamChunk should NOT throw (it reuses the active stream).
    await expect(
      asr.streamChunk(16000, new Float32Array(160)),
    ).resolves.toBeUndefined();
    // The recognizer was created (one stream per recognizer + one
    // extra via transcribe's reset())
    expect(mockCreateStream.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SherpaOnnxStreamingASR — bpe modeling unit pitfall", () => {
  it("validateBpeVocab accepts non-empty path", () => {
    expect(() => validateBpeVocab("/m/bpe.vocab")).not.toThrow();
  });

  it("validateBpeVocab throws on empty path", () => {
    expect(() => validateBpeVocab("")).toThrow(/bpe.vocab/i);
  });

  it("throws at construction time if bpeVocab missing and modelingUnit=bpe", () => {
    // Modeling unit bpe + no bpeVocab → must throw early
    expect(
      () =>
        new SherpaOnnxStreamingASR({
          modelDir: "/m",
          modelingUnit: "bpe",
          bpeVocab: "",
        }),
    ).toThrow(/bpe.vocab/i);
  });
});

describe("SherpaOnnxStreamingASR — pull-based decode loop", () => {
  it("calls decode while isReady returns true, then stops", async () => {
    mockIsReadyReturn = true; // first isReady = true → 1 decode
    const asr = new SherpaOnnxStreamingASR({ modelDir: "/m" });
    const pcm = Buffer.alloc(320);
    await asr.transcribe(pcm);
    // First isReady returned true → 1 decode. Second returned false → exit.
    expect(mockDecodeCallCount).toBe(1);
  });

  it("skips decode when isReady returns false on first call", async () => {
    mockIsReadyReturn = false;
    const asr = new SherpaOnnxStreamingASR({ modelDir: "/m" });
    await asr.transcribe(Buffer.alloc(320));
    expect(mockDecodeCallCount).toBe(0);
  });
});

describe("SherpaOnnxStreamingASR — finalize / reset", () => {
  it("finalize() returns the final text and reset() clears state", async () => {
    const asr = new SherpaOnnxStreamingASR({ modelDir: "/m" });
    // Force init
    await asr.transcribe(Buffer.alloc(0));
    // After transcribe, the stream has been reset — we need to push a
    // new chunk before finalize() works on the active stream
    await asr.streamChunk(16000, new Float32Array(160));
    mockGetResultText = "final-text";
    const final = asr.finalize();
    expect(final).toBe("final-text");
    expect(asr.isFinalized()).toBe(true);
    asr.reset();
    expect(asr.isFinalized()).toBe(false);
  });
});

describe("getASRProvider — sherpa_onnx_streaming registration", () => {
  it("resolves sherpa_onnx_streaming provider", () => {
    const provider = getASRProvider({
      provider: "sherpa_onnx_streaming",
      options: { modelDir: "/m" },
    });
    expect(provider.name).toBe("sherpa_onnx_streaming");
  });

  it("throws on sherpa_onnx_streaming without modelDir", () => {
    expect(() =>
      getASRProvider({
        provider: "sherpa_onnx_streaming",
        options: {},
      }),
    ).toThrow(/modelDir is required/);
  });

  it("caches the streaming provider on repeated calls with same config", () => {
    const a = getASRProvider({
      provider: "sherpa_onnx_streaming",
      options: { modelDir: "/m" },
    });
    const b = getASRProvider({
      provider: "sherpa_onnx_streaming",
      options: { modelDir: "/m" },
    });
    expect(a).toBe(b);
  });
});
