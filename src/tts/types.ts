/**
 * TTS provider abstraction.
 *
 * M3.4: parallel to ASR provider (asr/types.ts) and V2 bridge's
 * tts/base.py (src/xiaozhi_bridge/tts/base.py).
 *
 * Each provider takes text, yields PCM int16 chunks at the requested
 * sample rate (24kHz mono to match xiaozhi protocol's opus 24kHz frames).
 *
 * Why streaming (async generator) instead of one-shot:
 *   - LLM replies come in token-by-token → first sentence should TTS
 *     and start playing on esp32 BEFORE the full reply finishes
 *   - Per V2 edge-tts experience: 60ms PCM chunks → esp32 receives
 *     `tts sentence_start` early → "speaking" state on device
 */

export interface TTSChunk {
  /** Raw PCM int16 mono samples at `sampleRate`. */
  pcm: Buffer;
  /** Sentence text this chunk is synthesizing (for STT echo + display). */
  text: string;
  sampleRate: number;
  /** True for the FIRST chunk of a synthesis call (esp32 tts start). */
  isFirst: boolean;
  /** True for the LAST chunk of a synthesis call (esp32 tts stop). */
  isLast: boolean;
}

export interface TTSProvider {
  readonly name: string;
  /**
   * Synthesize text → stream PCM chunks. Each chunk is sentence-aligned
   * (text ends on a sentence boundary when possible).
   */
  synthesize(text: string): AsyncGenerator<TTSChunk>;
  /** Free native resources / close persistent connections. */
  dispose(): void;
}

/** Errors thrown by TTS providers. */
export class TTSError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TTSError";
  }
}
