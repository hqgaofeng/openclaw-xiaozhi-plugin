/**
 * ChannelGatewayAdapter — startAccount implementation.
 *
 * Starts a wss:// server bound to `host:port${path}` and routes
 * incoming esp32 connections to handleEsp32Connection (in inbound.ts).
 *
 * @see docs/sdk-research-v3.md §2.2 for the SMS plugin example we adapt.
 */

import type { ChannelGatewayAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { XiaozhiAccount } from "./config.js";

export function createXiaozhiGatewayAdapter(): ChannelGatewayAdapter<XiaozhiAccount> {
  return {
    // TODO(M3.2): implement startXiaozhiGatewayAccount
    //
    // Pseudocode:
    //   1. Validate account.enabled
    //   2. Create wss server (ws package)
    //   3. server.on('connection', (ws, req) => {
    //        handleEsp32Connection(ctx, ws, req, account)
    //      })
    //   4. server.on('error', (err) => log.error)
    //   5. await waitUntilAbort(abortSignal, () => server.close())
    //
    // Key considerations:
    //   - Per-device auth (Authorization: Bearer <token>) from V2 #6.1
    //   - WebSocket max message size 10 MB (config default)
    //   - TLS via account.tls if enabled (else plain ws for local dev)
  } as ChannelGatewayAdapter<XiaozhiAccount>;
}
