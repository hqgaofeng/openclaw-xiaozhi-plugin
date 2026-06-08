/**
 * ChannelMessagingAdapter — esp32 → openclaw inbound dispatch.
 *
 * Translates xiaozhi protocol messages to openclaw MsgContext and
 * dispatches them to the agent loop via ctx.channelRuntime.dispatch.
 *
 * 4 inbound message types:
 *   1. Hello    → create session (key = `xiaozhi-${deviceId}`)
 *   2. Listen   → write to audio queue (ASR auto-detect)
 *   3. Abort    → cancel current turn
 *   4. MCP      → tool router (M3.7)
 *
 * @see docs/sdk-research-v3.md §3.1 for the 1:1 translation table.
 */

import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { XiaozhiAccount } from "./config.js";

export function createXiaozhiMessagingAdapter(): ChannelMessagingAdapter {
  return {
    targetPrefixes: ["xiaozhi:"],
    deriveLegacySessionChatType: () => "direct",
    // TODO(M3.2): implement normalizeTarget
    //   "xiaozhi:esp32-58e6c56b9b54" → "esp32-58e6c56b9b54"
  } as ChannelMessagingAdapter;
}

/**
 * Handle a new esp32 WebSocket connection.
 *
 * Called from gateway.ts when an esp32 device connects.
 * Performs: hello handshake + auth + session create + message loop.
 */
export async function handleEsp32Connection(
  _ctx: unknown, // ChannelGatewayContext<XiaozhiAccount>
  _ws: unknown, // WebSocket
  _req: unknown, // IncomingMessage
  _account: XiaozhiAccount,
): Promise<void> {
  // TODO(M3.2): implement the connection loop
  //
  // Pseudocode:
  //   1. Extract Authorization, Device-Id, Protocol-Version headers
  //   2. Auth check (per-device token OR global token, V2 #6.1 logic)
  //   3. Wait for first message (must be Hello)
  //   4. Validate audio_params (16kHz opus, 60ms frame)
  //   5. Generate session_id (UUID)
  //   6. Send ServerHello with session_id
  //   7. Loop: receive message → parse → dispatch
  //      - Listen(start) + binary → audio chunk
  //      - Listen(stop) → endTurn
  //      - Listen(detect)+text → dispatch text
  //      - Abort → cancelTurn
  //      - MCP → handle mcp/inbound.ts
  //   8. On close: cleanup pending_mcp_calls + sessions
}
