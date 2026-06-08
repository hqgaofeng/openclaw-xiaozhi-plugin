/**
 * Opus ↔ PCM codec wrapper.
 *
 * State-per-session: each XiaozhiSession has 1 OpusCodec (for both
 * esp32→bridge decode at 16kHz and bridge→esp32 encode at 24kHz).
 *
 * @discordjs/opus quirk: it's CommonJS, and there's only ONE class
 * (OpusEncoder) that exposes both encode() and decode() methods.
 *
 * V2 #8.3 lesson: opuslib defaults to int16 — DO NOT pass float32
 * (silent output). xiaozhi protocol is int16 little-endian throughout.
 *
 * @see docs/sdk-research-v3.md §1.2 (4 key VAD/audio points)
 */

import opusPkg from "@discordjs/opus";
const { OpusEncoder } = opusPkg;

export type SampleRate = 16000 | 24000;
export const FRAME_DURATION_MS = 60 as const;

/** Frame size in samples for a given sample rate (60ms default). */
export function frameSize(sampleRate: SampleRate): number {
  return (sampleRate / 1000) * FRAME_DURATION_MS;
}

/** Frame size in bytes (int16 mono = 2 bytes per sample). */
export function frameSizeBytes(sampleRate: SampleRate): number {
  return frameSize(sampleRate) * 2;
}

export class OpusCodec {
  private readonly encoder: InstanceType<typeof OpusEncoder>;

  constructor(
    /** 16000 for esp32→bridge (mic), 24000 for bridge→esp32 (TTS). */
    public readonly sampleRate: SampleRate,
    public readonly channels: 1 = 1,
  ) {
    this.encoder = new OpusEncoder(sampleRate, channels);
  }

  /**
   * Decode an Opus frame to PCM int16 (little-endian).
   * Returns a Buffer of frameSizeBytes(sampleRate) bytes
   * (i.e. one 60ms frame at the codec's sample rate).
   */
  decode(opusFrame: Buffer): Buffer {
    if (opusFrame.length === 0) {
      // Silence: return zeroed PCM frame so callers always get frame-sized output.
      return Buffer.alloc(frameSizeBytes(this.sampleRate));
    }
    return this.encoder.decode(opusFrame);
  }

  /**
   * Encode PCM int16 (little-endian) to an Opus frame.
   * `pcm` MUST be exactly frameSizeBytes(sampleRate) bytes
   * (i.e. one 60ms frame at the codec's sample rate).
   */
  encode(pcm: Buffer): Buffer {
    if (pcm.length !== frameSizeBytes(this.sampleRate)) {
      throw new Error(
        `OpusCodec.encode: expected ${frameSizeBytes(this.sampleRate)} bytes ` +
        `(${FRAME_DURATION_MS}ms @ ${this.sampleRate}Hz int16 mono), got ${pcm.length}`,
      );
    }
    return this.encoder.encode(pcm);
  }

  /** Set bitrate (bits per second). */
  setBitrate(bitrate: number): void {
    this.encoder.setBitrate(bitrate);
  }

  getBitrate(): number {
    return this.encoder.getBitrate();
  }
}
