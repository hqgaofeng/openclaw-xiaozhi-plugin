/**
 * sherpa-onnx STREAMING ASR provider — v0.4.0-rc3 (batch 3).
 *
 * Pull-based OnlineRecognizer for low-latency partial results. Differs
 * from the offline SherpaOnnxASR in 3 key ways (all 3 V2 #1 pitfalls):
 *
 * 1. acceptWaveform takes **float32** in [-1, 1], NOT int16. The
 *    streaming provider exposes streamChunk(sampleRate, float32) to
 *    make this explicit. transcribe() converts int16→float32 internally.
 *
 * 2. modelingUnit MUST be "bpe" for the streaming-zipformer-bilingual
 *    model, and bpeVocab must be set. The constructor validates this
 *    and throws on missing bpeVocab (V2 silent empty text bug).
 *
 * 3. Decoding is **pull-based**: streamChunk → loop
 *    { isReady(stream) + decode(stream) } until isReady=false → getResult
 *    returns the (possibly partial) text. The stream is reused across
 *    chunks (NOT a new stream per call like offline).
 *
 * Usage:
 *   const asr = new SherpaOnnxStreamingASR({ modelDir: '/m' });
 *   await asr.transcribe(pcmBuffer); // int16 in, string out (full)
 *   // OR
 *   asr.streamChunk(16000, float32Chunk);
 *   const partial = asr.finalize();
 *
 * @see docs/sdk-research-v3.md §4 (sherpa-onnx 3 pitfalls)
 */

import type { ASRProvider, ASRResult, PCMBuffer } from "./types.js";
import { ASRError } from "./types.js";

export interface SherpaOnnxStreamingConfig {
  /** Directory containing tokens.txt + encoder/decoder/joiner .onnx. */
  modelDir: string;
  /** Defaults to 2 (V2 setting). */
  numThreads?: number;
  /** "cpu" (default) | "cuda". V2 only has cpu working. */
  provider?: "cpu" | "cuda";
  /** Decoding method. V2 default = greedy_search (lowest latency). */
  decodingMethod?: "greedy_search" | "modified_beam_search";
  /** Auto-detect int8 vs fp32 (default: prefer int8 if exists). */
  preferInt8?: boolean;
  /** "bpe" for the streaming-zipformer-bilingual model. DO NOT omit. */
  modelingUnit?: "bpe" | "cjkchar" | "cjk_bpe" | "en_bpe" | "char" | "bpe_cn";
  /** Path to bpe.vocab (REQUIRED when modelingUnit="bpe"). */
  bpeVocab?: string;
}

interface SherpaOnnxModule {
  createOnlineRecognizer(config: Record<string, unknown>): {
    free(): void;
    createStream(): {
      acceptWaveform(sampleRate: number, samples: Float32Array): void;
      inputFinished(): void;
    };
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    getResult(stream: unknown): { text: string };
  };
}

let _sherpa: SherpaOnnxModule | null = null;
async function loadSherpa(): Promise<SherpaOnnxModule> {
  if (_sherpa) return _sherpa;
  try {
    const mod = (await import("sherpa-onnx")) as unknown as {
      default?: SherpaOnnxModule;
    } & SherpaOnnxModule;
    _sherpa = (mod.default ?? mod) as SherpaOnnxModule;
    return _sherpa;
  } catch (err) {
    throw new ASRError(
      `sherpa-onnx-streaming: failed to load sherpa-onnx: ${(err as Error).message}`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True iff the input is a Float32Array — used to guard pitfall #1. */
export function isFloat32Array(x: unknown): x is Float32Array {
  return x instanceof Float32Array;
}

/** Pitfall #2 guard: bpe modeling unit requires a non-empty bpe.vocab. */
export function validateBpeVocab(bpeVocab: string | undefined): void {
  if (!bpeVocab || bpeVocab.trim() === "") {
    throw new ASRError(
      `sherpa-onnx-streaming: bpeVocab is required when modelingUnit="bpe" ` +
      `(V2 #1 pitfall #2 — silent empty text otherwise). ` +
      `Set options.bpeVocab to "<modelDir>/bpe.vocab".`,
    );
  }
}

// ---------------------------------------------------------------------------
// SherpaOnnxStreamingASR class
// ---------------------------------------------------------------------------

export class SherpaOnnxStreamingASR implements ASRProvider {
  readonly name = "sherpa_onnx_streaming";

  private recognizer: Awaited<
    ReturnType<SherpaOnnxModule["createOnlineRecognizer"]>
  > | null = null;
  private activeStream: ReturnType<
    NonNullable<typeof this.recognizer>["createStream"]
  > | null = null;
  private readonly config: Required<SherpaOnnxStreamingConfig>;
  private _finalized = false;

  constructor(config: SherpaOnnxStreamingConfig) {
    if (!config.modelDir) {
      throw new ASRError("sherpa-onnx-streaming: modelDir is required");
    }
    const modelingUnit = config.modelingUnit ?? "bpe";
    const bpeVocab = config.bpeVocab ?? `${config.modelDir}/bpe.vocab`;
    if (modelingUnit === "bpe") {
      validateBpeVocab(bpeVocab);
    }
    this.config = {
      modelDir: config.modelDir,
      numThreads: config.numThreads ?? 2,
      provider: config.provider ?? "cpu",
      decodingMethod: config.decodingMethod ?? "greedy_search",
      preferInt8: config.preferInt8 ?? true,
      modelingUnit,
      bpeVocab,
    } as Required<SherpaOnnxStreamingConfig>;
  }

  /** Returns the model directory passed to the constructor. */
  getModelDir(): string {
    return this.config.modelDir;
  }

  /** True after finalize() has been called. */
  isFinalized(): boolean {
    return this._finalized;
  }

  /** Lazily load model on first transcribe / streamChunk. */
  private async ensureLoaded(): Promise<void> {
    if (this.recognizer) return;
    const sherpa = await loadSherpa();
    const cfg = this.config;
    const int8 = cfg.preferInt8;
    const ext = int8 ? ".int8.onnx" : ".onnx";
    const recognizerConfig = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${cfg.modelDir}/encoder-epoch-99-avg-1${ext}`,
          decoder: `${cfg.modelDir}/decoder-epoch-99-avg-1${ext}`,
          joiner: `${cfg.modelDir}/joiner-epoch-99-avg-1${ext}`,
        },
        tokens: `${cfg.modelDir}/tokens.txt`,
        numThreads: cfg.numThreads,
        provider: cfg.provider,
        modelType: "zipformer",
        modelingUnit: cfg.modelingUnit,
        bpeVocab: cfg.bpeVocab,
      },
      decodingMethod: cfg.decodingMethod,
    };
    try {
      this.recognizer = sherpa.createOnlineRecognizer(recognizerConfig);
      this.activeStream = this.recognizer.createStream();
    } catch (err) {
      throw new ASRError(
        `sherpa-onnx-streaming: failed to create recognizer: ${(err as Error).message}\n` +
        `  modelDir: ${cfg.modelDir}\n` +
        `  preferInt8: ${cfg.preferInt8} (set false to use fp32)`,
        err,
      );
    }
  }

  /**
   * Stream a chunk of audio. The chunk MUST be Float32Array in [-1, 1]
   * at the given sampleRate (typically 16000). Throws on Buffer/int16
   * input (pitfall #1 — silent empty text otherwise).
   */
  async streamChunk(sampleRate: number, samples: Float32Array): Promise<void> {
    await this.ensureLoaded();
    if (!this.recognizer || !this.activeStream) {
      throw new ASRError("sherpa-onnx-streaming: recognizer not loaded");
    }
    if (!isFloat32Array(samples)) {
      const t = typeof samples;
      const ctorName = (samples as { constructor?: { name?: string } })?.constructor?.name;
      throw new ASRError(
        `sherpa-onnx-streaming.streamChunk: samples MUST be Float32Array ` +
        `in [-1, 1] (V2 #1 pitfall #1 — int16 produces silent empty text). ` +
        `Got: ${ctorName ?? t}`,
      );
    }
    this.activeStream.acceptWaveform(sampleRate, samples);
    // Pitfall #3: pull-based decode loop
    while (this.recognizer.isReady(this.activeStream)) {
      this.recognizer.decode(this.activeStream);
    }
  }

  /**
   * Signal that no more audio is coming. After this call,
   * getResult() returns the final text. isFinalized() returns true.
   */
  finalize(): string {
    if (!this.recognizer || !this.activeStream) {
      throw new ASRError("sherpa-onnx-streaming: recognizer not loaded");
    }
    this.activeStream.inputFinished();
    // Drain any remaining decode work
    while (this.recognizer.isReady(this.activeStream)) {
      this.recognizer.decode(this.activeStream);
    }
    const result = this.recognizer.getResult(this.activeStream);
    this._finalized = true;
    return result.text.trim();
  }

  /**
   * Clear the stream state so the next streamChunk / transcribe
   * starts fresh. Creates a new stream under the same recognizer.
   */
  reset(): void {
    if (this.recognizer) {
      this.activeStream = this.recognizer.createStream();
    }
    this._finalized = false;
  }

  /**
   * Convenience: transcribe a complete int16 PCM buffer in one call.
   * Equivalent to: streamChunk(16000, int16→float32) + finalize().
   * Resets the stream state at the end.
   */
  async transcribe(pcm: PCMBuffer): Promise<ASRResult> {
    await this.ensureLoaded();
    const start = Date.now();
    if (pcm.length > 0) {
      const float32 = int16ToFloat32(pcm);
      await this.streamChunk(16000, float32);
    }
    const text = this.finalize();
    this.reset();
    return { text, elapsedMs: Date.now() - start };
  }

  dispose(): void {
    if (this.recognizer) {
      this.recognizer.free();
      this.recognizer = null;
    }
    this.activeStream = null;
    this._finalized = false;
  }
}

/** Convert PCM int16 little-endian to Float32Array in [-1, 1]. */
function int16ToFloat32(pcm: Buffer): Float32Array {
  const samples = pcm.length / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}
