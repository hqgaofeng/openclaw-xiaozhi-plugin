/**
 * v0.3.6: post-TTS echo suppression tests.
 *
 * Reproduces the "wake word → same reply twice" bug:
 *   1. esp32 wake word "你好小智" → plugin TTS pushes "嘿，你好呀"
 *   2. esp32 mic re-captures the TTS audio (no AEC on the device)
 *   3. VAD fires on the echo, ASR returns garbage
 *   4. Agent loop gets dispatched → user hears the same reply twice
 *
 * The fix is two layers:
 *   1. While isSpeaking: drop mic frames in inbound.ts (M3.7.3.1 — already done)
 *   2. After TTS ends: POST_TTS_GRACE_MS (2s) suppression window. handleListenStop
 *      and VAD onSilence both check isInPostTtsGrace() and skip ASR+dispatch.
 */

import { describe, it, expect } from "vitest";
import {
  createSessionContext,
  markTtsEnded,
  isInPostTtsGrace,
  drainAudioBuffer,
  transitionTo,
} from "../session.js";

describe("v0.3.6: markTtsEnded / isInPostTtsGrace", () => {
  it("isInPostTtsGrace is false initially (never TTS-ed)", () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    expect(isInPostTtsGrace(s)).toBe(false);
  });

  it("isInPostTtsGrace is true right after markTtsEnded", () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    markTtsEnded(s, "嘿，你好呀");
    expect(isInPostTtsGrace(s)).toBe(true);
  });

  it("isInPostTtsGrace expires after postTtsGraceMs", async () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    s.postTtsGraceMs = 50; // shrink window for test
    markTtsEnded(s, "嘿，你好呀");
    expect(isInPostTtsGrace(s)).toBe(true);
    await new Promise((r) => setTimeout(r, 70));
    expect(isInPostTtsGrace(s)).toBe(false);
  });

  it("markTtsEnded records the last TTS text", () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    markTtsEnded(s, "嘿，你好呀");
    expect(s.lastTtsText).toBe("嘿，你好呀");
    expect(s.lastTtsEndedAt).toBeGreaterThan(0);
  });

  it("markTtsEnded updates timestamp on subsequent calls", async () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    markTtsEnded(s, "first reply");
    const t1 = s.lastTtsEndedAt;
    await new Promise((r) => setTimeout(r, 5));
    markTtsEnded(s, "second reply");
    expect(s.lastTtsEndedAt).toBeGreaterThan(t1);
    expect(s.lastTtsText).toBe("second reply");
  });
});

describe("v0.3.6: echo-suppression call sites — handleListenStop / VAD onSilence", () => {
  it("isInPostTtsGrace integrates with state machine (IDLE after TTS)", () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    transitionTo(s, "SPEAKING");
    markTtsEnded(s, "嘿，你好呀");
    transitionTo(s, "IDLE");
    // Even after SPEAKING→IDLE, we should still be in the grace
    // window — the device mic can echo up to 2s after the audio
    // actually finishes playing.
    expect(s.state).toBe("IDLE");
    expect(isInPostTtsGrace(s)).toBe(true);
  });

  it("drainAudioBuffer can be safely called when in grace (no-op dispatch)", () => {
    const s = createSessionContext("dev1", "sess1", { sampleRate: 16000, channels: 1 } as never);
    s.audioBuffer = [Buffer.from("a"), Buffer.from("b")];
    markTtsEnded(s, "嘿，你好呀");
    // The VAD watcher / listen stop path drains first, then returns
    // before ASR. The drain itself is fine — it's the dispatch we
    // skip.
    const frames = drainAudioBuffer(s);
    expect(frames).toHaveLength(2);
    expect(s.audioBuffer).toHaveLength(0);
  });
});
