/**
 * SessionContext — per-esp32 connection state.
 *
 * 1:1 translation of bridge/src/xiaozhi_bridge/protocol/states.py
 * SessionState + bridge/src/xiaozhi_bridge/server.py SessionContext.
 *
 * State machine:
 *   [IDLE] ──listen start──> [LISTENING] ──tts start──> [SPEAKING]
 *      ▲                          │                          │
 *      │                          └─abort────────────────────┤
 *      │                                                     │
 *      └──────────────────tts stop────────────────────────────┘
 */

export type SessionState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

export interface SessionContext {
  // Identity
  deviceId: string;
  sessionId: string;
  openclawSessionKey: string;  // = `xiaozhi-${deviceId}` (M3.6: per-device memory)

  // State
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;

  // Pending MCP calls (V2 #7 / M3.7)
  // Map: mcp_request_id (string|number) → Promise resolver
  pendingMcpCalls: Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>;

  // Audio
  audioBuffer: Buffer[];      // accumulating Opus frames during LISTENING
  codec: import("./audio.js").OpusCodec;

  // VAD
  vad: unknown;               // SileroVAD instance (or null if not enabled)
  wakeGraceUntil: number;     // timestamp — VAD disabled until this time
}

export function createSessionContext(
  deviceId: string,
  sessionId: string,
  codec: import("./audio.js").OpusCodec,
): SessionContext {
  // TODO(M3.2): implement — return fully-initialized SessionContext
  //   - openclawSessionKey = `xiaozhi-${deviceId}` (M3.6)
  //   - state = "IDLE"
  //   - pendingMcpCalls = new Map()
  //   - audioBuffer = []
  //   - createdAt = lastActivityAt = Date.now()
  //   - vad = null (A3 过渡期不跑服务端 VAD)
  //   - wakeGraceUntil = 0
  return {
    deviceId,
    sessionId,
    openclawSessionKey: `xiaozhi-${deviceId}`,
    state: "IDLE",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    pendingMcpCalls: new Map(),
    audioBuffer: [],
    codec,
    vad: null,
    wakeGraceUntil: 0,
  };
}
