/**
 * Protocol tests — 25 cases for xiaozhi message schema.
 *
 * TDD approach: tests define the contract before implementation.
 * Each test asserts parse/serialize round-trip + edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  parseClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../protocol.js";

describe("parseClientMessage: Hello", () => {
  it("accepts a valid hello with all fields", () => {
    const raw = JSON.stringify({
      type: "hello",
      version: 1,
      features: { mcp: true },
      transport: "websocket",
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 60,
      },
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("hello");
  });

  it("accepts hello with minimum fields (no features/transport)", () => {
    const raw = JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 60,
      },
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("hello");
  });

  it("rejects hello with wrong sample_rate", () => {
    const raw = JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: {
        format: "opus",
        sample_rate: 8000,
        channels: 1,
        frame_duration: 60,
      },
    });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("rejects hello with wrong frame_duration", () => {
    const raw = JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 20,
      },
    });
    expect(() => parseClientMessage(raw)).toThrow();
  });
});

describe("parseClientMessage: Listen", () => {
  it("accepts listen with state=start, mode=auto", () => {
    const raw = JSON.stringify({
      type: "listen",
      state: "start",
      mode: "auto",
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("listen");
  });

  it("accepts listen with state=stop", () => {
    const raw = JSON.stringify({ type: "listen", state: "stop" });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("listen");
  });

  it("accepts listen with state=detect + text", () => {
    const raw = JSON.stringify({
      type: "listen",
      state: "detect",
      text: "你好小智",
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("listen");
  });

  it("rejects listen with invalid state", () => {
    const raw = JSON.stringify({ type: "listen", state: "bogus" });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("rejects listen with invalid mode", () => {
    const raw = JSON.stringify({
      type: "listen",
      state: "start",
      mode: "wrongmode",
    });
    expect(() => parseClientMessage(raw)).toThrow();
  });
});

describe("parseClientMessage: Abort", () => {
  it("accepts abort with reason", () => {
    const raw = JSON.stringify({
      type: "abort",
      reason: "wake_word_detected",
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("abort");
  });

  it("accepts abort without reason", () => {
    const raw = JSON.stringify({ type: "abort" });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("abort");
  });
});

describe("parseClientMessage: MCP", () => {
  it("accepts MCP with jsonrpc 2.0 payload", () => {
    const raw = JSON.stringify({
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "set_volume", arguments: { volume: 50 } },
      },
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("mcp");
  });

  it("accepts MCP with string id", () => {
    const raw = JSON.stringify({
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id: "abc",
        result: { content: [{ type: "text", text: "true" }] },
      },
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe("mcp");
  });
});

describe("serializeServerMessage: ServerHello", () => {
  it("serializes a valid server hello", () => {
    const msg: ServerMessage = {
      type: "hello",
      transport: "websocket",
      session_id: "xiaozhi-abc123",
      audio_params: {
        format: "opus",
        sample_rate: 24000,
        channels: 1,
        frame_duration: 60,
      },
    };
    const raw = serializeServerMessage(msg);
    const parsed = JSON.parse(raw);
    expect(parsed.session_id).toBe("xiaozhi-abc123");
  });
});

describe("serializeServerMessage: TTS state machine", () => {
  it("serializes tts start", () => {
    const msg: ServerMessage = { type: "tts", state: "start" };
    expect(serializeServerMessage(msg)).toContain('"state":"start"');
  });

  it("serializes tts sentence_start with text", () => {
    const msg: ServerMessage = {
      type: "tts",
      state: "sentence_start",
      text: "你好世界",
    };
    expect(serializeServerMessage(msg)).toContain("你好世界");
  });

  it("serializes tts stop", () => {
    const msg: ServerMessage = { type: "tts", state: "stop" };
    expect(serializeServerMessage(msg)).toContain('"state":"stop"');
  });
});

describe("serializeServerMessage: STT", () => {
  it("serializes stt with text result", () => {
    const msg: ServerMessage = { type: "stt", text: "你好小智" };
    expect(serializeServerMessage(msg)).toContain("你好小智");
  });
});

describe("serializeServerMessage: LLM (emotion)", () => {
  it("serializes llm with emotion + emoji", () => {
    const msg: ServerMessage = { type: "llm", emotion: "happy", text: "😀" };
    expect(serializeServerMessage(msg)).toContain("😀");
  });

  it("serializes llm without emotion (default neutral)", () => {
    const msg: ServerMessage = { type: "llm", text: "🤔" };
    expect(serializeServerMessage(msg)).toContain("🤔");
  });
});

describe("serializeServerMessage: System", () => {
  it("serializes system reboot command", () => {
    const msg: ServerMessage = { type: "system", command: "reboot" };
    expect(serializeServerMessage(msg)).toContain('"command":"reboot"');
  });
});

describe("parseClientMessage: edge cases", () => {
  it("rejects non-JSON", () => {
    expect(() => parseClientMessage("not json")).toThrow();
  });

  it("rejects message with unknown type", () => {
    const raw = JSON.stringify({ type: "unknown_type" });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("rejects message with missing type", () => {
    const raw = JSON.stringify({ data: "x" });
    expect(() => parseClientMessage(raw)).toThrow();
  });

  it("handles session_id as optional on all message types", () => {
    // Both with and without session_id should parse
    const withId = JSON.stringify({
      session_id: "xiaozhi-1",
      type: "abort",
    });
    const withoutId = JSON.stringify({ type: "abort" });
    expect(parseClientMessage(withId).type).toBe("abort");
    expect(parseClientMessage(withoutId).type).toBe("abort");
  });
});

describe("round-trip: client parse → server serialize", () => {
  it("preserves the full hello handshake cycle", () => {
    // 1. esp32 → bridge: hello
    const c2s = JSON.stringify({
      type: "hello",
      version: 1,
      features: { mcp: true },
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 60,
      },
    });
    const c2sMsg: ClientMessage = parseClientMessage(c2s);
    expect(c2sMsg.type).toBe("hello");

    // 2. bridge → esp32: server hello
    const s2c: ServerMessage = {
      type: "hello",
      transport: "websocket",
      session_id: "xiaozhi-round-trip",
      audio_params: {
        format: "opus",
        sample_rate: 24000,
        channels: 1,
        frame_duration: 60,
      },
    };
    const s2cRaw = serializeServerMessage(s2c);
    const s2cParsed: ServerMessage = JSON.parse(s2cRaw);
    expect(s2cParsed.session_id).toBe("xiaozhi-round-trip");
  });
});
