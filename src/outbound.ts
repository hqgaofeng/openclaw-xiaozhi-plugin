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
 * @see docs/sdk-research-v3.md §3.2 for the 1:1 translation table.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";

export function createXiaozhiOutboundAdapter(): ChannelOutboundAdapter {
  return {
    // TODO(M3.2): implement sendText
    //   ws.send(JSON.stringify({ type: "stt", session_id, text }))

    // TODO(M3.2): implement sendTtsAudio
    //   1. ws.send({ type: "tts", state: "start" })
    //   2. ws.send({ type: "tts", state: "sentence_start", text })
    //   3. ws.send(audio)  // Opus frames
    //   4. ws.send({ type: "tts", state: "stop" })

    // TODO(M3.2): implement sendMedia
    //   ws.send({ type: "llm", emotion, text: emoji })
  } as ChannelOutboundAdapter;
}
