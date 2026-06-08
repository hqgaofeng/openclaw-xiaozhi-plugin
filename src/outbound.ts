/**
 * ChannelOutboundAdapter — openclaw → esp32 outbound delivery.
 *
 * Translates openclaw outbound calls (sendText / sendTtsAudio / sendMedia)
 * to xiaozhi protocol messages (stt / tts / llm).
 *
 * 3 outbound types:
 *   1. sendText      → xiaozhi STTMessage (text result)
 *   2. sendTtsAudio  → xiaozhi TTS state machine (start/sentence_start/frames/stop)
 *   3. sendMedia     → xiaozhi LLMMessage (emotion + emoji)
 *
 * M3.2: each function takes the esp32 WebSocket + sessionId directly.
 *       M3.4 will wire to the openclaw OutboundContext which provides these.
 *
 * @see docs/sdk-research-v3.md §3.2 for the 1:1 translation table.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { WebSocket } from "ws";
import { serializeServerMessage } from "./protocol.js";

/** Send STT (ASR result) to esp32. */
export function sendSttMessage(ws: WebSocket, sessionId: string, text: string): void {
  const raw = serializeServerMessage({ type: "stt", session_id: sessionId, text });
  ws.send(raw);
}

/** Send LLM (emotion + emoji) to esp32. */
export function sendLlmMessage(
  ws: WebSocket,
  sessionId: string,
  emotion: string | undefined,
  text: string,
): void {
  const raw = serializeServerMessage({
    type: "llm",
    session_id: sessionId,
    ...(emotion ? { emotion } : {}),
    text,
  });
  ws.send(raw);
}

/** Send TTS state machine: start → sentence_start(+text) → frames → stop. */
export function sendTtsAudio(
  ws: WebSocket,
  sessionId: string,
  text: string,
  opusFrames: Buffer[],
): void {
  ws.send(serializeServerMessage({ type: "tts", session_id: sessionId, state: "start" }));
  ws.send(serializeServerMessage({ type: "tts", session_id: sessionId, state: "sentence_start", text }));
  for (const frame of opusFrames) {
    ws.send(frame, { binary: true });
  }
  ws.send(serializeServerMessage({ type: "tts", session_id: sessionId, state: "stop" }));
}

/** Send System command (e.g. reboot after OTA). */
export function sendSystemCommand(ws: WebSocket, sessionId: string, command: string): void {
  ws.send(serializeServerMessage({ type: "system", session_id: sessionId, command }));
}

export function createXiaozhiOutboundAdapter(): ChannelOutboundAdapter {
  return {
    // M3.4: these will delegate to sendSttMessage/sendLlmMessage/etc with
    // the OutboundContext-resolved ws and sessionId.
  } as ChannelOutboundAdapter;
}
