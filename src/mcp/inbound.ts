/**
 * MCP inbound — esp32 → openclaw tool router.
 *
 * esp32 reports a tool list via MCPMessage with method=tools/list.
 * Each reported tool is registered as a dynamic openclaw agent tool.
 *
 * M3.2 阶段: 实现工具注册 + adapter pattern (真正的 openclaw
 * agentTools.push 集成在 M3.4 接 channelRuntime 后做)
 *
 * @see docs/sdk-research-v3.md §3.3 (Case 1)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2
 */

import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-runtime";
import type { WebSocket } from "ws";
import { createPendingMcpCall } from "./outbound.js";
import type { SessionContext } from "../session.js";

/** Shape of a tool reported by esp32 (MCP JSON-RPC tools/list response). */
export interface Esp32Tool {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Adapter that wraps an esp32 tool as an openclaw agent tool. */
export function createEsp32ToolAdapter(
  ws: WebSocket,
  session: SessionContext,
  tool: Esp32Tool,
): ChannelAgentTool {
  // Note: sessionId is implicit via the WebSocket's session.
  // Caller passes the same ws to ensure responses route back to the right device.
  void ws;  // Reserved for future per-connection dispatch
  return {
    label: `esp32_${tool.name}`,
    name: `esp32_${tool.name}`,
    description: tool.description ?? `ESP32 device tool: ${tool.name}`,
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as ChannelAgentTool["parameters"],
    execute: async (_toolCallId: string, params: unknown) => {
      // Call the esp32 tool via MCP JSON-RPC.
      // M3.7 wiring: this is where we will send the JSON-RPC request to
      // esp32 and await the response.
      void _toolCallId;
      void params;
      // For M3.2, create a pending call and immediately reject (not yet
      // wired to openclaw's outbound). M3.4 will wire this through the
      // real channelRuntime.
      const { id, future } = createPendingMcpCall(session);
      void id;
      return {
        content: [
          {
            type: "text" as const,
            text: "M3.2 stub: openclaw agent → esp32 tool dispatch not yet wired",
          },
        ],
        details: await future.catch(() => ({ error: "not_wired" })),
      };
    },
  };
}

/**
 * Register a list of esp32-reported tools into the openclaw agentTools list.
 * M3.4: agentTools is part of MsgContext / channelRuntime; for M3.2 we
 * just return the adapters and let the caller attach them.
 */
export function handleMcpToolsList(
  tools: Esp32Tool[],
  ws: WebSocket,
  session: SessionContext,
): ChannelAgentTool[] {
  return tools.map((tool) => createEsp32ToolAdapter(ws, session, tool));
}
