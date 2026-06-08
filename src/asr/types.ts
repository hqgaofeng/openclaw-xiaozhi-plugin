/**
 * ASR provider abstraction.
 *
 * M3.4: parallel to V2 bridge's asr/base.py (src/xiaozhi_bridge/asr/base.py).
 * Each provider takes a PCM int16 buffer (16kHz mono esp32 audio) and
 * returns the recognized text.
 *
 * The 3 V2 #1 sherpa-onnx pitfalls that bit us then are documented in
 * sherpa-onnx.ts — DO NOT change modelingUnit / accept_waveform type /
 * decode loop without re-reading that file.
 */

/** Raw PCM 16kHz mono int16 little-endian audio. */
export type PCMBuffer = Buffer;

export interface ASRResult {
  text: string;
  /** Time-to-first-byte for partial results (ms). 0 for offline. */
  elapsedMs?: number;
}

export interface ASRProvider {
  readonly name: string;
  /**
   * Transcribe a complete audio buffer (one utterance).
   * Returns recognized text. May be empty string if VAD detected no speech.
   */
  transcribe(pcm: PCMBuffer): Promise<ASRResult>;
  /**
   * Stream partial recognition as audio arrives.
   * Yields partial text updates, then final text. M3.4 uses transcribe() only.
   */
  stream?(pcm: PCMBuffer, onPartial: (text: string) => void): Promise<ASRResult>;
  /** Free native resources. */
  dispose(): void;
}

/** Errors thrown by ASR providers. */
export class ASRError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ASRError";
  }
}
