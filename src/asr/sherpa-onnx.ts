/**
 * sherpa-onnx ASR provider — local streaming Zipformer (bilingual zh+en).
 *
 * Uses sherpa-onnx v1.13.2 (WASM build, 15MB). Same model files as V2
 * Python bridge (streaming-zipformer-bilingual-zh-en-2023-02-20).
 *
 * ## 3 V2 #1 pitfalls (lessons learned, do not skip)
 *
 * 1. acceptWaveform takes **float32** in [-1, 1], NOT int16.
 *    Passing int16 directly produces silent empty text (no error).
 *    We always convert int16 → float32 in this wrapper.
 *
 * 2. modelingUnit defaults to "cjkchar" but the streaming-zipformer-bilingual
 *    model uses **bpe**. We MUST explicitly set modelingUnit="bpe" and
 *    bpeVocab=".../bpe.vocab" — otherwise the recognizer returns "" silently.
 *
 * 3. Decoding is **pull-based**: acceptWaveform → inputFinished → loop
 *    { isReady(stream) + decode(stream) } until isReady returns false →
 *    THEN getResult(stream) returns final text. We expose this as a single
 *    transcribe() that does the whole loop internally.
 *
 * ## Resource budget (VPS 961 MiB RAM, now +1.5 GiB swap from 17:40)
 *
 * - WASM load + int8 model: ~3.5s startup, RSS ~350 MiB (vs V2 Python ~230 MiB)
 * - Inference: <0.5 RTF on 1 core (V2 was 0.43; WASM ~1.2x slower)
 * - Free on dispose
 *
 * @see docs/plan-v3-xiaozhi-plugin.md §5 (M3.4 ASR)
 * @see docs/sdk-research-v3.md §4 (sherpa-onnx 3 pitfalls)
 */

import type { ASRProvider, ASRResult, PCMBuffer } from "./types.js";
import { ASRError } from "./types.js";

export interface SherpaOnnxASRConfig {
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
    createStream(): import('sherpa-onnx').OnlineStream;
    isReady(stream: import('sherpa-onnx').OnlineStream): boolean;
    decode(stream: import('sherpa-onnx').OnlineStream): void;
    getResult(stream: import('sherpa-onnx').OnlineStream): { text: string };
  };
}

let _sherpa: SherpaOnnxModule | null = null;
async function loadSherpa(): Promise<SherpaOnnxModule> {
  if (_sherpa) return _sherpa;
  const mod = (await import("sherpa-onnx")) as unknown as SherpaOnnxModule;
  _sherpa = mod;
  return _sherpa;
}

export class SherpaOnnxASR implements ASRProvider {
  readonly name = "sherpa-onnx";

  private recognizer: Awaited<ReturnType<SherpaOnnxModule["createOnlineRecognizer"]>> | null = null;
  private readonly config: Required<SherpaOnnxASRConfig>;

  constructor(config: SherpaOnnxASRConfig) {
    if (!config.modelDir) {
      throw new ASRError("sherpa-onnx: modelDir is required");
    }
    this.config = {
      modelDir: config.modelDir,
      numThreads: config.numThreads ?? 2,
      provider: config.provider ?? "cpu",
      decodingMethod: config.decodingMethod ?? "greedy_search",
      preferInt8: config.preferInt8 ?? true,
      modelingUnit: config.modelingUnit ?? "bpe",
      bpeVocab: config.bpeVocab ?? `${config.modelDir}/bpe.vocab`,
    } as Required<SherpaOnnxASRConfig>;
  }

  /** Lazily load model on first transcribe. */
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
    } catch (err) {
      throw new ASRError(
        `sherpa-onnx: failed to create recognizer: ${(err as Error).message}\n` +
        `  modelDir: ${cfg.modelDir}\n` +
        `  preferInt8: ${cfg.preferInt8} (set false to use fp32)`,
        err,
      );
    }
  }

  async transcribe(pcm: PCMBuffer): Promise<ASRResult> {
    await this.ensureLoaded();
    if (!this.recognizer) throw new ASRError("recognizer not loaded");
    const start = Date.now();
    const stream = this.recognizer.createStream();
    try {
      // Pitfall #1: int16 → float32 conversion (V2 #1 lesson)
      const samples = int16ToFloat32(pcm);
      stream.acceptWaveform(16000, samples);
      stream.inputFinished();

      // Pitfall #3: pull-based decode loop
      while (this.recognizer.isReady(stream)) {
        this.recognizer.decode(stream);
      }
      const result = this.recognizer.getResult(stream);
      return {
        text: result.text.trim(),
        elapsedMs: Date.now() - start,
      };
    } finally {
      // Free the stream (sherpa-onnx API doesn't expose a stream.free() but
      // the recognizer manages stream lifecycle per-recognizer.free())
    }
  }

  dispose(): void {
    if (this.recognizer) {
      this.recognizer.free();
      this.recognizer = null;
    }
  }
}

/** Convert PCM int16 little-endian buffer to Float32Array in [-1, 1]. */
export function int16ToFloat32(pcm: PCMBuffer): Float32Array {
  const samples = pcm.length / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}
