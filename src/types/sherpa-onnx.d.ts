/**
 * Minimal sherpa-onnx module declarations.
 * sherpa-onnx v1.13.2 ships only index.js (CJS) — no .d.ts.
 * We declare just the surface we use.
 */
declare module "sherpa-onnx" {
  export interface OnlineStream {
    readonly handle: number;
    acceptWaveform(sampleRate: number, samples: Float32Array): void;
    inputFinished(): void;
  }
  export interface OnlineRecognizer {
    free(): void;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    getResult(stream: OnlineStream): { text: string };
  }
  export interface OfflineRecognizer {
    free(): void;
  }
  export interface OfflineTts {
    free(): void;
    generate(text: string): { samples: Float32Array; sampleRate: number };
  }
  const sherpa: {
    createOnlineRecognizer(config: Record<string, unknown>): OnlineRecognizer;
    createOfflineRecognizer(config: Record<string, unknown>): OfflineRecognizer;
    createOfflineTts(config: Record<string, unknown>): OfflineTts;
    readWave(filename: string): { samples: Float32Array; sampleRate: number };
    version: string;
  };
  export default sherpa;
}
