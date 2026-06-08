/**
 * MCP outbound — openclaw agent tool → esp32, and esp32 response → openclaw.
 *
 * Two directions:
 *   A. openclaw agent tool call → esp32 (sendMcpCall, M3.7)
 *   B. esp32 response → resolve pending call (resolveMcpResponse, M3.7)
 *
 * Mirrors V2 #7 bridge/src/xiaozhi_bridge/mcp/handlers.py:
 *   - send_mcp_call(ws, session, tool_name, arguments)  → send MCP tools/call
 *   - _handle_mcp(ws, session, msg)                     → resolve future
 *
 * @see docs/sdk-research-v3.md §3.3 (Cases 1 + 2)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2
 */

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  addPendingMcpCall,
  resolvePendingMcpCall,
  type SessionContext,
} from "../session.js";
import { serializeServerMessage, type ServerMessage } from "../protocol.js";
import { MCP_METHODS } from "./protocol.js";

/**
 * Register a pending MCP call (caller awaits the future).
 * The future is resolved by resolveMcpResponse when esp32 replies.
 */
export function createPendingMcpCall(
  session: SessionContext,
  requestId: string | number,
): { future: Promise<unknown> } {
  return { future: addPendingMcpCall(session, requestId) };
}

/**
 * Send a tools/call JSON-RPC 2.0 request to the esp32 device.
 *
 * - Allocates a per-session request id (monotonic, stored on session).
 * - Stashes the response future in session.pendingMcpCalls.
 * - Awaits the future, returning the parsed result to the caller.
 *
 * Mirrors V2 #7 send_mcp_call exactly. The future is resolved by
 * resolveMcpResponse when the device sends a JSON-RPC response.
 *
 * @param ws       esp32 WebSocket to send on
 * @param session  per-connection session context
 * @param toolName esp32 tool name (e.g. "self.light.set_rgb")
 * @param args     tool call arguments
 * @returns        the esp32 tool's result (the `result` field of the JSON-RPC response)
 * @throws         on JSON-RPC error response, network failure, or session disconnect
 */
export async function sendMcpCall(
  ws: WebSocket,
  session: SessionContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Per-session monotonic request id (V2 #7 design — overlapping ids
  // are safe across different sessions, since pendingMcpCalls is
  // per-session).
  if (!Number.isInteger((session as { mcpRequestId?: number }).mcpRequestId)) {
    (session as { mcpRequestId?: number }).mcpRequestId = 0;
  }
  const mcpReq = session as unknown as { mcpRequestId: number };
  mcpReq.mcpRequestId += 1;
  const requestId = mcpReq.mcpRequestId;

  // Stash the future BEFORE sending, so resolveMcpResponse can find it
  // even if esp32 responds in the same tick (very fast tools).
  const { future } = createPendingMcpCall(session, requestId);

  // Build the JSON-RPC 2.0 payload.
  const msg = {
    type: "mcp" as const,
    session_id: session.sessionId,
    payload: {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: MCP_METHODS.TOOLS_CALL,
      params: { name: toolName, arguments: args },
    },
  };

  ws.send(serializeServerMessage(msg as unknown as ServerMessage));

  // Await the response. This blocks the agent's tool execution until
  // esp32 replies. If esp32 disconnects mid-call, cleanupSession()
  // rejects the future with "session_disconnected".
  return future;
}

/**
 * Build a tools/list request (server → client) — used during handshake
 * to ask esp32 what tools it has. M3.7: the response is handled by
 * registerEsp32Tools().
 */
export function buildToolsListRequest(sessionId: string): string {
  const id = randomUUID();
  const msg = {
    type: "mcp" as const,
    session_id: sessionId,
    payload: {
      jsonrpc: "2.0" as const,
      id,
      method: MCP_METHODS.TOOLS_LIST,
    },
  };
  return serializeServerMessage(msg as unknown as ServerMessage);
}

/**
 * Resolve a pending MCP call when esp32 sends a response.
 *
 * Called by inbound handler when a `mcp` type message arrives.
 *
 * @param session    the per-connection session
 * @param requestId  the JSON-RPC id from the response
 * @param payload    { result: ... } or { error: ... } (normalized)
 * @returns          true if a matching pending call was found and resolved
 */
export function resolveMcpResponse(
  session: SessionContext,
  requestId: string | number,
  payload: { result?: unknown; error?: unknown },
): boolean {
  // Normalize: prefer result over error (one or the other is present
  // in a well-formed JSON-RPC response; if both, error wins per spec).
  const value =
    payload.error !== undefined ? { error: payload.error } : payload.result;
  return resolvePendingMcpCall(session, String(requestId), value);
}

/**
 * Reject a pending MCP call (e.g. on timeout). Used by timeout
 * watchdog in higher-level code.
 */
export function rejectMcpResponse(
  session: SessionContext,
  requestId: string | number,
  reason: Error,
): boolean {
  const call = session.pendingMcpCalls.get(String(requestId));
  if (!call) return false;
  session.pendingMcpCalls.delete(String(requestId));
  call.reject(reason);
  return true;
}
