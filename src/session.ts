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

  // M3.7.3 server-side VAD: track listen mode from esp32's listen.start
  // and run our own VAD when the device pushes a non-manual mode (esp32
  // firmware in CONFIG_USE_DEVICE_AEC=y mode never sends a listen.stop
  // — it waits for either a wake word interrupt or a touch key, both of
  // which leave the user stuck in "listening" if they want a back-and-
  // forth). The official xiaozhi-esp32-server (core/handle/receiveAudioHandle.py
  // + core/providers/vad/silero.py) runs a silero VAD on every audio
  // frame and uses a 1s-silence threshold to trigger a voice-stop — the
  // ASR layer then triggers the rest of the pipeline. We mirror that
  // here with a much simpler RMS-energy VAD (no onnx runtime needed).
  /** Listen mode from listen.start message: "auto" | "manual" | "realtime". */
  clientListenMode: "auto" | "manual" | "realtime" | null;
  /** Active VadWatcher (started when LISTENING in non-manual mode). */
  vadWatcher: { stop: () => void } | null;

  // v0.3.6: TTS echo suppression (mirrors xiaozhi-esp32-server
  //   _should_ignore_audio_while_speaking + frogchou's
  //   _speak_grace_until). Without AEC on the device, the esp32
  //   mic re-captures the TTS audio we just sent, the VAD fires
  //   on the echo, ASR returns garbage, and the agent loop is
  //   dispatched a 2nd time on the same wake word.
  //
  //   The fix is two-layered:
  //   1. While isSpeaking (TTS in flight): drop mic frames in
  //      inbound.ts binary handler (already done in M3.7.3.1).
  //   2. After TTS ends: set lastTtsEndedAt + lastTtsText. For
  //      POST_TTS_GRACE_MS (default 2000ms) after TTS stop, the
  //      VAD watcher + ASR echo-detection both suppress dispatches.
  lastTtsText: string | null;
  lastTtsEndedAt: number;
  /** Window after TTS end during which mic input is treated as echo. */
  postTtsGraceMs: number;

  // v0.3.7 (Bug 3 fix): in-flight TTS abort flag. When esp32 sends an
  // `abort` message, the inbound handler sets this to true. The
  // streamTtsToOpusFrames loop checks it on every chunk and breaks
  // early — preventing late TTS audio from reaching the device after
  // the user has already interrupted. Cleared on next Listen.start.
  aborted: boolean;
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
    clientListenMode: null,
    vadWatcher: null,
    lastTtsText: null,
    lastTtsEndedAt: 0,
    // Bug 5 fix: was 6000ms (cover VAD max-turn + slack) — too long
    // for realtime mode where esp32 auto-enters listening after tts.stop.
    // User speech that starts within 6s gets suppressed by
    // bufferHasSpeech() = false (only the echo, no real speech yet),
    // and the session goes to IDLE while the user is mid-utterance.
    // 1500ms is enough to cover the TTS echo tail (typically <1s)
    // without choking off natural back-and-forth conversation.
    postTtsGraceMs: 1500,
    aborted: false,        // v0.3.7: no in-flight TTS to cancel yet
  };
}

/**
 * v0.3.6: mark a TTS push as just-completed. Call this in the
 * TTS pipeline's finally block so subsequent VAD stop / ASR
 * dispatches know the audio is in the post-TTS echo window.
 */
export function markTtsEnded(
  session: SessionContext,
  text: string,
  log?: { info: (msg: string, ...args: unknown[]) => void },
): void {
  session.lastTtsText = text;
  session.lastTtsEndedAt = Date.now();
  if (log) {
    log.info(
      `xiaozhi: ${session.deviceId} TTS ended, post-grace window ` +
      `${session.postTtsGraceMs}ms active until ` +
      `${new Date(session.lastTtsEndedAt + session.postTtsGraceMs).toISOString().slice(11, 19)}`,
    );
  }
}

/**
 * v0.3.6: returns true if we are inside the post-TTS echo grace
 * window. Callers (VAD watcher stop, ASR echo detector) use this
 * to decide whether to drop the current mic input as echo.
 */
export function isInPostTtsGrace(session: SessionContext): boolean {
  if (session.lastTtsEndedAt === 0) return false;
  return Date.now() - session.lastTtsEndedAt < session.postTtsGraceMs;
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
  // M3.7.3: stop our server-side VAD watcher (if any) so we don't
  // leave a setInterval running after the device disconnects.
  if (session.vadWatcher) {
    session.vadWatcher.stop();
    session.vadWatcher = null;
  }
  session.audioBuffer = [];
}
