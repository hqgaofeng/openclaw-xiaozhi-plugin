/**
 * Outbound tests — 15 cases for openclaw → esp32 delivery.
 *
 * Tests verify the translation table in sdk-research-v3.md §3.2
 * (openclaw outbound calls → xiaozhi protocol messages).
 */

import { describe, it, expect, vi } from "vitest";
import { createXiaozhiOutboundAdapter } from "../outbound.js";

describe("Outbound: sendText → STT", () => {
  it("serializes to xiaozhi STTMessage with session_id and text", () => {
    // TODO(M3.2): mock ws.send, call sendText({ text: "你好" }), assert ws.send
    //   called with JSON.stringify({ type: "stt", session_id: "...", text: "你好" })
  });
});

describe("Outbound: sendTtsAudio → TTS state machine", () => {
  it("emits tts.start before audio frames", () => {
    // TODO(M3.2): mock ws.send, call sendTtsAudio, assert first send is
    //   { type: "tts", state: "start" }
  });

  it("emits tts.sentence_start + text for each sentence", () => {
    // TODO(M3.2): mock ws.send, call sendTtsAudio with 2 sentences, assert
    //   2 sentence_start messages interleaved with audio
  });

  it("emits tts.stop after last audio frame", () => {
    // TODO(M3.2): mock ws.send, call sendTtsAudio, assert last send is
    //   { type: "tts", state: "stop" }
  });

  it("sends 24kHz Opus frames (bridge→esp32 audio format)", () => {
    // TODO(M3.2): assert ws.send called with audio buffer matching 24kHz Opus
  });
});

describe("Outbound: sendMedia → LLM emotion", () => {
  it("emits LLMMessage with emotion + emoji", () => {
    // TODO(M3.2): mock ws.send, call sendMedia, assert
    //   { type: "llm", emotion: "happy", text: "😀" }
  });

  it("handles missing emotion (default neutral)", () => {
    // TODO(M3.2): mock ws.send, call sendMedia without emotion, assert
    //   { type: "llm", text: "🤔" }
  });
});

describe("Outbound: errors", () => {
  it("throws if no session for accountId", async () => {
    // TODO(M3.2): call sendText with unknown accountId, expect throw
  });

  it("throws if ws is closed (delivery failure)", async () => {
    // TODO(M3.2): mock ws with readyState=CLOSED, call sendText, expect throw
  });
});

describe("Outbound: MCP reverse call (M3.7)", () => {
  it("emits MCPMessage with jsonrpc tools/call", () => {
    // TODO(M3.7): mock ws.send, call sendMcpCall("set_volume", { volume: 50 }),
    //   assert { type: "mcp", payload: { jsonrpc, id, method, params } }
  });

  it("awaits response in pendingMcpCalls", async () => {
    // TODO(M3.7): populate pendingMcpCalls with resolved future, assert sendMcpCall returns
  });

  it("cleans up pendingMcpCalls after response", async () => {
    // TODO(M3.7): after response, assert pendingMcpCalls.get(id) === undefined
  });
});

describe("Outbound: System message (reboot)", () => {
  it("emits SystemMessage with command=reboot", () => {
    // TODO(M3.2): mock ws.send, call sendSystemReboot, assert
    //   { type: "system", command: "reboot" }
  });
});
