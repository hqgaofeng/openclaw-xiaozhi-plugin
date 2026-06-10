/**
 * Multi-flag state machine tests — v0.4.0-rc3 (batch 3).
 *
 * Allen 15:39 GMT+8 拍板: 4 个新 flag 加到 SessionContext,但默认
 * 全部 false / undefined,只有 useMultiFlagState=true 时才启用。
 *
 * 4 new flags on SessionContext:
 *   - clientHaveVoice: boolean    — esp32 has actually pushed voice frames
 *   - clientVoiceStop: boolean    — esp32 has explicitly said voice stop
 *   - lastIsVoice:    boolean    — most recent VAD decision was "voice"
 *   - vadLastVoiceTime: number    — ms timestamp of last voice frame
 *
 * State machine interaction:
 *   - 现有 `state: SessionState` 字段不动
 *   - 现有 transitionTo() 不动
 *   - 新 flag 不参与 transitionTo — 它们是 VAD / 客户端信号的副产物
 *
 * Tests:
 *   - defaults: all 4 flags are false / 0 on a fresh session
 *   - existing state field is unchanged
 *   - existing transitionTo() still works
 *   - flag manipulation is independent of state
 *   - useMultiFlagState gate is read at runtime, not construction time
 *   - 4 flags can be set / reset independently
 *   - vadLastVoiceTime can be set to a timestamp
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionContext, transitionTo, type SessionContext } from "../session.js";
import { OpusCodec } from "../audio.js";

let mockUseMultiFlagState = false;
let mockUseSileroVad = false;
let mockUseAccumulatePcm = false;
let mockUseStreamingAsr = false;

vi.mock("../api.js", () => {
  return {
    getUseMultiFlagState: () => mockUseMultiFlagState,
    getUseSileroVad: () => mockUseSileroVad,
    getUseAccumulatePcm: () => mockUseAccumulatePcm,
    getUseStreamingAsr: () => mockUseStreamingAsr,
    getUseRetry: () => false,
    getMetricsEnabled: () => false,
  };
});

import {
  getMultiFlagStateEnabled,
  setClientHaveVoice,
  setClientVoiceStop,
  setLastIsVoice,
  setVadLastVoiceTime,
  resetMultiFlagState,
} from "../session-flags.js";

beforeEach(() => {
  mockUseMultiFlagState = false;
  mockUseSileroVad = false;
  mockUseAccumulatePcm = false;
  mockUseStreamingAsr = false;
});

function makeSession(): SessionContext {
  const codec = {} as OpusCodec;
  return createSessionContext("esp32-test", "xiaozhi-test", codec);
}

describe("Multi-flag defaults", () => {
  it("clientHaveVoice defaults to false on a fresh session", () => {
    const s = makeSession();
    expect(s.clientHaveVoice).toBe(false);
  });

  it("clientVoiceStop defaults to false on a fresh session", () => {
    const s = makeSession();
    expect(s.clientVoiceStop).toBe(false);
  });

  it("lastIsVoice defaults to false on a fresh session", () => {
    const s = makeSession();
    expect(s.lastIsVoice).toBe(false);
  });

  it("vadLastVoiceTime defaults to 0 on a fresh session", () => {
    const s = makeSession();
    expect(s.vadLastVoiceTime).toBe(0);
  });
});

describe("Multi-flag independence from existing state", () => {
  it("existing `state` field is unchanged (still IDLE)", () => {
    const s = makeSession();
    expect(s.state).toBe("IDLE");
  });

  it("existing transitionTo() still works (IDLE → LISTENING)", async () => {
    const s = makeSession();
    // Wait at least 1ms so lastActivityAt > createdAt (both were set
    // in the same Date.now() tick in createSessionContext)
    await new Promise((r) => setTimeout(r, 5));
    transitionTo(s, "LISTENING");
    expect(s.state).toBe("LISTENING");
    expect(s.lastActivityAt).toBeGreaterThan(s.createdAt);
  });

  it("transitionTo() does NOT touch the 4 new flags", () => {
    const s = makeSession();
    transitionTo(s, "LISTENING");
    expect(s.clientHaveVoice).toBe(false);
    expect(s.clientVoiceStop).toBe(false);
    expect(s.lastIsVoice).toBe(false);
    expect(s.vadLastVoiceTime).toBe(0);
  });
});

describe("Multi-flag helpers — feature gate", () => {
  it("getMultiFlagStateEnabled() returns false when flag is off", () => {
    mockUseMultiFlagState = false;
    expect(getMultiFlagStateEnabled()).toBe(false);
  });

  it("getMultiFlagStateEnabled() returns true when flag is on", () => {
    mockUseMultiFlagState = true;
    expect(getMultiFlagStateEnabled()).toBe(true);
  });
});

describe("Multi-flag helpers — flag manipulation", () => {
  it("setClientHaveVoice(true) flips the flag", () => {
    const s = makeSession();
    setClientHaveVoice(s, true);
    expect(s.clientHaveVoice).toBe(true);
    setClientHaveVoice(s, false);
    expect(s.clientHaveVoice).toBe(false);
  });

  it("setClientVoiceStop(true) flips the flag", () => {
    const s = makeSession();
    setClientVoiceStop(s, true);
    expect(s.clientVoiceStop).toBe(true);
  });

  it("setLastIsVoice(true) flips the flag", () => {
    const s = makeSession();
    setLastIsVoice(s, true);
    expect(s.lastIsVoice).toBe(true);
  });

  it("setVadLastVoiceTime(t) sets the timestamp", () => {
    const s = makeSession();
    setVadLastVoiceTime(s, 1234567890);
    expect(s.vadLastVoiceTime).toBe(1234567890);
  });

  it("resetMultiFlagState() clears all 4 flags", () => {
    const s = makeSession();
    setClientHaveVoice(s, true);
    setClientVoiceStop(s, true);
    setLastIsVoice(s, true);
    setVadLastVoiceTime(s, 999);
    resetMultiFlagState(s);
    expect(s.clientHaveVoice).toBe(false);
    expect(s.clientVoiceStop).toBe(false);
    expect(s.lastIsVoice).toBe(false);
    expect(s.vadLastVoiceTime).toBe(0);
  });

  it("4 flags can be set independently in any order", () => {
    const s = makeSession();
    setVadLastVoiceTime(s, 100);
    expect(s.vadLastVoiceTime).toBe(100);
    expect(s.clientHaveVoice).toBe(false);
    setClientHaveVoice(s, true);
    expect(s.clientHaveVoice).toBe(true);
    expect(s.vadLastVoiceTime).toBe(100);
    setLastIsVoice(s, true);
    expect(s.clientVoiceStop).toBe(false);
  });
});
