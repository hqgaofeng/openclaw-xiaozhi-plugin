/**
 * OpusCodec tests — 8 cases for audio encode/decode + frame sizing.
 *
 * V2 #8.3 lesson encoded: int16 only, no float32.
 *
 * Note: we don't test that decode(encode(x)) === x bit-perfectly (Opus
 * is lossy). We test structural invariants: round-trip produces a
 * frame of correct size, silence encodes to a small frame, the codec
 * doesn't crash on edge inputs.
 */

import { describe, it, expect } from "vitest";
import { OpusCodec, frameSize, frameSizeBytes, FRAME_DURATION_MS } from "../audio.js";

describe("frameSize", () => {
  it("16000 Hz × 60 ms = 960 samples", () => {
    expect(frameSize(16000)).toBe(960);
  });

  it("24000 Hz × 60 ms = 1440 samples", () => {
    expect(frameSize(24000)).toBe(1440);
  });

  it("frameSizeBytes = samples × 2 (int16 mono)", () => {
    expect(frameSizeBytes(16000)).toBe(1920);
    expect(frameSizeBytes(24000)).toBe(2880);
  });

  it("FRAME_DURATION_MS is 60 (xiaozhi protocol default)", () => {
    expect(FRAME_DURATION_MS).toBe(60);
  });
});

describe("OpusCodec construction", () => {
  it("creates a 16kHz codec for esp32→bridge (mic input)", () => {
    const codec = new OpusCodec(16000);
    expect(codec.sampleRate).toBe(16000);
    expect(codec.channels).toBe(1);
  });

  it("creates a 24kHz codec for bridge→esp32 (TTS output)", () => {
    const codec = new OpusCodec(24000);
    expect(codec.sampleRate).toBe(24000);
  });
});

describe("OpusCodec.encode: silence", () => {
  it("encodes a 60ms silence frame to a small Opus packet (DTX/CNG included)", () => {
    const codec = new OpusCodec(16000);
    const silence = Buffer.alloc(frameSizeBytes(16000)); // all zeros
    const opus = codec.encode(silence);
    // Opus silence (DTX) can be 2-3 bytes OR include a CNG/SID frame (~60-80 bytes).
    // We just check it's reasonably small (< 1/10 of PCM input).
    expect(opus.length).toBeGreaterThan(0);
    expect(opus.length).toBeLessThan(frameSizeBytes(16000) / 10);
  });
});

describe("OpusCodec.encode: errors on wrong size", () => {
  it("throws if pcm is not exactly frameSizeBytes", () => {
    const codec = new OpusCodec(16000);
    const tooShort = Buffer.alloc(100);
    expect(() => codec.encode(tooShort)).toThrow(/expected 1920 bytes/);
  });
});

describe("OpusCodec.decode: empty input returns silence", () => {
  it("returns a frame-sized zero buffer when given empty input", () => {
    const codec = new OpusCodec(16000);
    const decoded = codec.decode(Buffer.alloc(0));
    expect(decoded.length).toBe(frameSizeBytes(16000));
    // All zeros
    for (const b of decoded) {
      expect(b).toBe(0);
    }
  });
});

describe("OpusCodec round-trip", () => {
  it("decode(encode(pcm)) yields a frame of correct size (lossy, no exact match)", () => {
    const codec = new OpusCodec(16000);
    // Random-ish non-zero PCM (low amplitude, not all-zeros so Opus doesn't DTX)
    const pcm = Buffer.alloc(frameSizeBytes(16000));
    for (let i = 0; i < pcm.length; i += 2) {
      pcm.writeInt16LE(Math.floor(Math.sin(i / 100) * 1000), i);
    }
    const opus = codec.encode(pcm);
    const decoded = codec.decode(opus);
    expect(decoded.length).toBe(frameSizeBytes(16000));
  });
});

describe("OpusCodec bitrate control", () => {
  it("setBitrate + getBitrate returns the set value", () => {
    const codec = new OpusCodec(16000);
    codec.setBitrate(32000);
    expect(codec.getBitrate()).toBe(32000);
  });
});
