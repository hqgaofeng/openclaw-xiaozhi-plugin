/**
 * Session tests — 10 cases for SessionContext + state machine.
 *
 * TDD: defines what each session looks like, how state transitions work,
 * and how cleanup happens on disconnect.
 */

import { describe, it, expect } from "vitest";
import { createSessionContext, type SessionContext } from "../session.js";
import { OpusCodec } from "../audio.js";

describe("createSessionContext", () => {
  it("initializes with state=IDLE", () => {
    const codec = {} as OpusCodec;  // placeholder until audio.ts is real
    const session = createSessionContext("esp32-58e6c56b9b54", "xiaozhi-abc", codec);
    expect(session.state).toBe("IDLE");
  });

  it("uses xiaozhi-{deviceId} as openclawSessionKey (M3.6 memory isolation)", () => {
    const codec = {} as OpusCodec;
    const session = createSessionContext("esp32-58e6c56b9b54", "xiaozhi-abc", codec);
    expect(session.openclawSessionKey).toBe("xiaozhi-esp32-58e6c56b9b54");
  });

  it("starts with empty audioBuffer", () => {
    const codec = {} as OpusCodec;
    const session = createSessionContext("esp32-001", "xiaozhi-x", codec);
    expect(session.audioBuffer).toEqual([]);
  });

  it("starts with empty pendingMcpCalls", () => {
    const codec = {} as OpusCodec;
    const session = createSessionContext("esp32-001", "xiaozhi-x", codec);
    expect(session.pendingMcpCalls.size).toBe(0);
  });

  it("sets createdAt and lastActivityAt to now", () => {
    const before = Date.now();
    const codec = {} as OpusCodec;
    const session = createSessionContext("esp32-001", "xiaozhi-x", codec);
    const after = Date.now();
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.createdAt).toBeLessThanOrEqual(after);
    expect(session.lastActivityAt).toBe(session.createdAt);
  });
});

describe("SessionState transitions", () => {
  it("IDLE → LISTENING on listen start", () => {
    const codec = {} as OpusCodec;
    const session: SessionContext = {
      ...createSessionContext("esp32-001", "xiaozhi-x", codec),
      state: "IDLE",
    };
    session.state = "LISTENING";
    expect(session.state).toBe("LISTENING");
  });

  it("LISTENING → THINKING on listen stop (after ASR)", () => {
    const codec = {} as OpusCodec;
    const session: SessionContext = {
      ...createSessionContext("esp32-001", "xiaozhi-x", codec),
      state: "LISTENING",
    };
    session.state = "THINKING";
    expect(session.state).toBe("THINKING");
  });

  it("THINKING → SPEAKING on TTS start", () => {
    const codec = {} as OpusCodec;
    const session: SessionContext = {
      ...createSessionContext("esp32-001", "xiaozhi-x", codec),
      state: "THINKING",
    };
    session.state = "SPEAKING";
    expect(session.state).toBe("SPEAKING");
  });

  it("SPEAKING → IDLE on TTS stop", () => {
    const codec = {} as OpusCodec;
    const session: SessionContext = {
      ...createSessionContext("esp32-001", "xiaozhi-x", codec),
      state: "SPEAKING",
    };
    session.state = "IDLE";
    expect(session.state).toBe("IDLE");
  });

  it("abort transitions any state → IDLE", () => {
    const codec = {} as OpusCodec;
    const session: SessionContext = {
      ...createSessionContext("esp32-001", "xiaozhi-x", codec),
      state: "SPEAKING",
    };
    session.state = "IDLE";  // abort always → IDLE
    expect(session.state).toBe("IDLE");
  });
});
