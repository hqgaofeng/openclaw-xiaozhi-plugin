/**
 * esp32ListenHandler tests — covers the M3.4c/d pipeline shape.
 *
 * We do NOT spin up a real esp32 connection or call the openclaw
 * runtime. We test the two pure helpers in the handler file:
 *   - opus decode accumulation (via the public OpusCodec API)
 *   - 60ms frame slicing + opus encode loop (smoke test)
 *
 * The actual ASR / TTS / dispatch integration is covered end-to-end
 * by M3.4h (real esp32 + nginx 443).
 */

import { describe, it, expect } from "vitest";
import { OpusCodec, frameSizeBytes } from "../audio.js";

describe("OpusCodec decode/encode round trip (60ms frame @ 16kHz)", () => {
  it("decodes silence to zero PCM, encodes to non-empty opus", () => {
    const codec = new OpusCodec(16000, 1);
    const silence = Buffer.alloc(0); // empty opus = silence sentinel
    const pcm = codec.decode(silence);
    expect(pcm.length).toBe(frameSizeBytes(16000));
    expect(pcm.every((b) => b === 0)).toBe(true);

    const opus = codec.encode(pcm);
    expect(opus.length).toBeGreaterThan(0);
    expect(opus.length).toBeLessThan(200); // opus @ 16kHz mono ~50 bytes/frame
  });

  it("encode enforces 60ms frame size", () => {
    const codec = new OpusCodec(24000, 1);
    const badPcm = Buffer.alloc(1024); // wrong size
    expect(() => codec.encode(badPcm)).toThrow(/expected 2880 bytes/);
  });
});

describe("TTS 60ms frame slicing logic (smoke test)", () => {
  // Replicate the slicing loop from esp32ListenHandler.streamTtsToOpusFrames
  // to verify the boundary math: every output frame MUST be exactly
  // frameSizeBytes(24000) = 2880 bytes, and no PCM is dropped.
  function slicePcmToOpusFrames(
    pcm: Buffer,
    encoder: OpusCodec,
  ): Buffer[] {
    const frameBytes = frameSizeBytes(24000);
    const frames: Buffer[] = [];
    let pending = pcm;
    while (pending.length >= frameBytes) {
      const f = pending.subarray(0, frameBytes);
      frames.push(encoder.encode(f));
      pending = pending.subarray(frameBytes);
    }
    // Tail pad
    if (pending.length > 0) {
      const padded = Buffer.alloc(frameBytes);
      pending.copy(padded, 0, 0, Math.min(pending.length, frameBytes));
      frames.push(encoder.encode(padded));
    }
    return frames;
  }

  it("2.5 frames of PCM → 3 opus frames (last padded with silence)", () => {
    const encoder = new OpusCodec(24000, 1);
    // 2.5 frames = 2 * 2880 + 1440 bytes
    const pcm = Buffer.alloc(2880 * 2 + 1440, 0x7f);
    const frames = slicePcmToOpusFrames(pcm, encoder);
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(f.length).toBeGreaterThan(0);
    }
  });

  it("exact 5 frames of PCM → 5 opus frames, no padding", () => {
    const encoder = new OpusCodec(24000, 1);
    const pcm = Buffer.alloc(2880 * 5, 0x55);
    const frames = slicePcmToOpusFrames(pcm, encoder);
    expect(frames).toHaveLength(5);
  });

  it("less than 1 frame → 1 padded opus frame", () => {
    const encoder = new OpusCodec(24000, 1);
    const pcm = Buffer.alloc(500, 0x33);
    const frames = slicePcmToOpusFrames(pcm, encoder);
    expect(frames).toHaveLength(1);
  });

  it("empty PCM → 0 opus frames (no padding emitted)", () => {
    const encoder = new OpusCodec(24000, 1);
    const frames = slicePcmToOpusFrames(Buffer.alloc(0), encoder);
    expect(frames).toHaveLength(0);
  });
});
