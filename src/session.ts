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

import { OpusCodec } from "./audio.js";

export type SessionState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

export interface PendingMcpCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface SessionContext {
  // Identity
  deviceId: string;
  sessionId: string;
  /** M3.6: per-device memory isolation. */
  openclawSessionKey: string;

  // State
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;

  // Pending MCP calls (V2 #7 / M3.7)
  // Map: mcp_request_id (string) → Promise resolver
  pendingMcpCalls: Map<string, PendingMcpCall>;

  // Audio
  audioBuffer: Buffer[];      // accumulating Opus frames during LISTENING
  codec: OpusCodec;

  // VAD
  vad: unknown;               // SileroVAD instance (or null if not enabled)
  /** VAD disabled until this timestamp (wake word tail buffer). */
  wakeGraceUntil: number;
}

export function createSessionContext(
  deviceId: string,
  sessionId: string,
  codec: OpusCodec,
): SessionContext {
  const now = Date.now();
  return {
    deviceId,
    sessionId,
    openclawSessionKey: `xiaozhi-${deviceId}`,
    state: "IDLE",
    createdAt: now,
    lastActivityAt: now,
    pendingMcpCalls: new Map(),
    audioBuffer: [],
    codec,
    vad: null,
    wakeGraceUntil: 0,
  };
}

/** Transition to a new state, updating lastActivityAt. */
export function transitionTo(session: SessionContext, state: SessionState): void {
  session.state = state;
  session.lastActivityAt = Date.now();
}

/** Append an Opus frame to the session audio buffer. */
export function appendAudioFrame(session: SessionContext, opusFrame: Buffer): void {
  session.audioBuffer.push(opusFrame);
  session.lastActivityAt = Date.now();
}

/** Drain the audio buffer and return all accumulated frames. */
export function drainAudioBuffer(session: SessionContext): Buffer[] {
  const frames = session.audioBuffer;
  session.audioBuffer = [];
  return frames;
}

/** Add a pending MCP call and return the Promise that resolves when it completes. */
export function addPendingMcpCall(
  session: SessionContext,
  requestId: string | number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.pendingMcpCalls.set(String(requestId), { resolve, reject });
  });
}

/** Resolve a pending MCP call (called when esp32 sends a response). */
export function resolvePendingMcpCall(
  session: SessionContext,
  requestId: string | number,
  result: unknown,
): boolean {
  const call = session.pendingMcpCalls.get(String(requestId));
  if (!call) return false;
  session.pendingMcpCalls.delete(String(requestId));
  call.resolve(result);
  return true;
}

/**
 * Cleanup on session disconnect:
 *   1. Reject all pending MCP calls with a CancellationError
 *   2. Drop the audio buffer
 */
export function cleanupSession(session: SessionContext): void {
  for (const [id, call] of session.pendingMcpCalls.entries()) {
    call.reject(new Error("session_disconnected"));
    session.pendingMcpCalls.delete(id);
  }
  session.audioBuffer = [];
}
