/**
 * MCP outbound — openclaw agent tool → esp32.
 *
 * Sends a JSON-RPC 2.0 tools/call message to esp32 and awaits the
 * response (stored in session.pendingMcpCalls).
 *
 * @see docs/sdk-research-v3.md §3.3 (Case 2)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2
 */

import type { XiaozhiContext } from "./types.js";

export async function sendMcpCall(
  _ctx: XiaozhiContext,
  _name: string,
  _args: Record<string, unknown>,
): Promise<unknown> {
  // TODO(M3.7): implement
  //
  //   1. Generate request id (incremental counter or ulid)
  //   2. Create future + store in session.pendingMcpCalls
  //   3. Send ws.send(JSON.stringify({
  //        type: "mcp",
  //        session_id: ctx.sessionId,
  //        payload: {
  //          jsonrpc: "2.0",
  //          id: reqId,
  //          method: "tools/call",
  //          params: { name, arguments: args },
  //        },
  //      }))
  //   4. await future
  //   5. cleanup pendingMcpCalls in finally
  //
  // Pitfall (V2 #7):
  //   esp32 id type is string "1" or int 1 — coerce with String()
  return null;
}
