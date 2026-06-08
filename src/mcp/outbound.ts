/**
 * MCP outbound — openclaw agent tool → esp32, and esp32 response → openclaw.
 *
 * Two directions:
 *   A. openclaw agent tool call → esp32 (buildMcpRequestMessage, M3.7 future)
 *   B. esp32 response → resolve pending call (sendMcpResponse, M3.2)
 *
 * @see docs/sdk-research-v3.md §3.3 (Cases 1 + 2)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2
 */

import { randomUUID } from "node:crypto";
import {
  addPendingMcpCall,
  resolvePendingMcpCall,
  type SessionContext,
} from "../session.js";
import { serializeServerMessage, type ServerMessage } from "../protocol.js";

/**
 * Register a pending MCP call (caller awaits the future).
 * The future is resolved by sendMcpResponse when esp32 replies.
 * M3.7: used by createEsp32ToolAdapter.execute.
 */
export function createPendingMcpCall(session: SessionContext): { id: string; future: Promise<unknown> } {
  const id = randomUUID();
  const future = addPendingMcpCall(session, id);
  return { id, future };
}

/**
 * Resolve a pending MCP call when esp32 sends a response.
 * Returns true if a matching pending call was found and resolved.
 */
export function sendMcpResponse(
  session: SessionContext,
  requestId: string,
  payload: { result?: unknown; error?: unknown },
): boolean {
  // Normalize: prefer result over error
  const value = payload.error !== undefined ? { error: payload.error } : payload.result;
  return resolvePendingMcpCall(session, requestId, value);
}

/**
 * Build an MCP request message (server → client, JSON-RPC 2.0).
 * M3.7: called by openclaw agent tool dispatch.
 *
 * Returns the serialized JSON string to send on the esp32 WebSocket.
 */
export function buildMcpRequestMessage(
  sessionId: string,
  requestId: string,
  method: string,
  args: Record<string, unknown>,
): string {
  // The Server union doesn't include mcp, but the esp32 protocol accepts
  // it. Cast through unknown.
  const msg = {
    type: "mcp" as const,
    session_id: sessionId,
    payload: { jsonrpc: "2.0", id: requestId, method, params: { name: method, arguments: args } },
  };
  return serializeServerMessage(msg as unknown as ServerMessage);
}
