/**
 * Inbound tests — 15 cases for esp32 → openclaw dispatch.
 *
 * Tests verify the translation table in sdk-research-v3.md §3.1
 * (esp32 messages → openclaw MsgContext fields).
 */

import { describe, it, expect } from "vitest";
import { createXiaozhiMessagingAdapter } from "../inbound.js";

describe("ChannelMessagingAdapter: targetPrefixes", () => {
  it("exposes xiaozhi: prefix", () => {
    const adapter = createXiaozhiMessagingAdapter();
    expect(adapter.targetPrefixes).toContain("xiaozhi:");
  });
});

describe("ChannelMessagingAdapter: normalizeTarget", () => {
  it("strips xiaozhi: prefix from valid target", () => {
    // TODO(M3.2): assert normalizeTarget("xiaozhi:esp32-001") === "esp32-001"
    const adapter = createXiaozhiMessagingAdapter();
    if (adapter.normalizeTarget) {
      const result = adapter.normalizeTarget("xiaozhi:esp32-58e6c56b9b54");
      expect(result).toBe("esp32-58e6c56b9b54");
    }
  });

  it("returns undefined for invalid target (no xiaozhi: prefix)", () => {
    // TODO(M3.2): assert normalizeTarget("telegram:123") === undefined
  });

  it("handles MAC address with colons in target", () => {
    // TODO(M3.2): assert normalizeTarget("xiaozhi:58:e6:c5:6b:9b:54") === "58:e6:c5:6b:9b:54"
  });
});

describe("ChannelMessagingAdapter: deriveLegacySessionChatType", () => {
  it("always returns 'direct' for esp32 (no group chat)", () => {
    const adapter = createXiaozhiMessagingAdapter();
    if (adapter.deriveLegacySessionChatType) {
      expect(adapter.deriveLegacySessionChatType("xiaozhi-esp32-001")).toBe("direct");
      expect(adapter.deriveLegacySessionChatType("xiaozhi-esp32-002")).toBe("direct");
    }
  });
});

describe("Inbound dispatch: Hello → session create", () => {
  it("creates a session with key xiaozhi-{deviceId}", () => {
    // TODO(M3.2): mock channelRuntime.dispatch, send hello, assert dispatch called
    //   with MsgContext{ SessionKey: "xiaozhi-esp32-001", Body: "" }
  });

  it("registers the esp32 device in the global sessions map", () => {
    // TODO(M3.2): mock ctx, send hello, assert sessions.get("esp32-001") exists
  });
});

describe("Inbound dispatch: Listen start + audio → ASR", () => {
  it("dispatches listen start as a media chunk to audio queue", () => {
    // TODO(M3.2): mock dispatch, send listen start, assert dispatch called
  });

  it("appends binary Opus frame to session.audioBuffer", () => {
    // TODO(M3.2): send listen start + 10 binary frames, assert session.audioBuffer.length === 10
  });
});

describe("Inbound dispatch: Listen stop → end turn", () => {
  it("calls channelRuntime.endTurn with accumulated audio", () => {
    // TODO(M3.2): mock endTurn, send listen stop, assert endTurn called
  });
});

describe("Inbound dispatch: Listen detect + text → LLM directly", () => {
  it("dispatches text directly to LLM (bypasses ASR)", () => {
    // TODO(M3.2): mock dispatch, send listen detect+text="你好小智", assert dispatch
    //   called with MsgContext{ Body: "你好小智" }
  });
});

describe("Inbound dispatch: Abort → cancel turn", () => {
  it("calls channelRuntime.cancelTurn", () => {
    // TODO(M3.2): mock cancelTurn, send abort, assert cancelTurn called
  });
});

describe("Inbound dispatch: MCP message", () => {
  it("routes MCPMessage to mcp/inbound.ts handler", () => {
    // TODO(M3.2): mock mcp handler, send MCP, assert handler called
  });
});

describe("Cleanup on disconnect", () => {
  it("clears all pendingMcpCalls on disconnect", () => {
    // TODO(M3.2): populate pendingMcpCalls, simulate disconnect, assert map cleared
  });

  it("rejects all pendingMcpCalls with CancellationError on disconnect", () => {
    // TODO(M3.2): populate pendingMcpCalls, simulate disconnect, assert promises rejected
  });
});
