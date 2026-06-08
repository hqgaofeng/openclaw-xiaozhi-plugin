/**
 * esp32 Tool Registry — M3.7.2 dynamic MCP tool injection.
 *
 * Maps deviceId → { tools, ws, session, payload } so that when the
 * LLM invokes an esp32-prefixed tool, we can route the call to the
 * correct device's WebSocket.
 *
 * Why a separate module (not in tools.ts)?
 *   - Keeps the per-connection state (ws, session) out of the
 *     agent-tool layer, which is supposed to be channel-scoped
 *     and stateless.
 *   - Mirrors the deviceRegistry pattern in tools.ts (global
 *     Map singleton) so the design is symmetric.
 *
 * @see src/mcp/inbound.ts (caller: handleMcpResponse tools/list path)
 * @see src/mcp/tools.ts (caller: createEsp32DeviceToolRouter)
 */

import type { WebSocket } from "ws";
import type { SessionContext } from "../session.js";
import type { McpTool } from "./protocol.js";

export interface Esp32DeviceToolState {
  /** All tools reported by this esp32 device during its handshake. */
  tools: McpTool[];
  /** The device's live WebSocket (used to forward tools/call requests). */
  ws: WebSocket;
  /** The per-connection session (for pending-call tracking). */
  session: SessionContext;
  /** When the device last reported its tool list. */
  lastReportedAt: number;
}

/** Map: deviceId → tool state. */
export type Esp32ToolRegistry = Map<string, Esp32DeviceToolState>;

const globalRegistry: Esp32ToolRegistry = new Map();

export function getEsp32ToolRegistry(): Esp32ToolRegistry {
  return globalRegistry;
}

export function registerEsp32Tools(
  deviceId: string,
  state: Esp32DeviceToolState,
): void {
  globalRegistry.set(deviceId, state);
}

export function unregisterEsp32Tools(deviceId: string): void {
  globalRegistry.delete(deviceId);
}

export function getEsp32DeviceTools(deviceId: string): McpTool[] | null {
  return globalRegistry.get(deviceId)?.tools ?? null;
}
