/**
 * openclaw agent tool — xiaozhi_list_devices + M3.7.2 esp32 device tool router.
 *
 * xiaozhi_list_devices:
 *   Static tool. Lists connected devices from the global registry.
 *
 * M3.7.2 createEsp32DeviceToolRouter (ChannelAgentToolFactory):
 *   Lazy: called by openclaw's tool discovery with the LLM call's
 *   session context. The router enumerates all esp32 devices in the
 *   registry and returns one ChannelAgentTool per tool per device.
 *   When the LLM calls `esp32_${deviceId}_${toolName}`, the router
 *   routes it to the right device's WebSocket.
 *
 * Why "esp32_<deviceId>_<tool>" naming?
 *   - LLM can call a specific tool on a specific device
 *   - Names are unique across devices (no collisions)
 *   - esp32_MAC_TOOL format is grepable in logs
 *
 * @see src/mcp/registry.ts (device state)
 * @see src/mcp/outbound.ts sendMcpCall
 * @see docs/sdk-research-v3.md §2.6
 */

import type { ChannelAgentTool, ChannelAgentToolFactory } from "openclaw/plugin-sdk/channel-runtime";
import { getEsp32ToolRegistry } from "./registry.js";
import { sendMcpCall } from "./outbound.js";
import { buildLlmToolsPayload as _buildLlmToolsPayload } from "./inbound.js";
import type { McpTool } from "./protocol.js";
import type { SessionContext } from "../session.js";

/** Mirror of the xiaozhi_list_devices tool (kept for parity). */
export function createListDevicesTool(): ChannelAgentTool {
  return {
    label: "xiaozhi_list_devices",
    name: "xiaozhi_list_devices",
    description:
      "List all connected ESP32 xiaozhi devices with their session_id, state, and last_seen timestamp.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      const reg = getEsp32ToolRegistry();
      const devices = Array.from(reg.entries()).map(([deviceId, st]) => ({
        deviceId,
        toolCount: st.tools.length,
        toolNames: st.tools.map((t) => t.name),
        lastReportedAt: st.lastReportedAt,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(devices, null, 2),
          },
        ],
        details: devices,
      };
    },
  };
}

/**
 * Sanitize a deviceId for use in a tool name (LLM tool names allow
 * [a-zA-Z0-9_-]). Replaces non-allowed chars with underscore.
 */
export function sanitizeDeviceId(deviceId: string): string {
  return deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Build a per-device-tool LLM-callable adapter. */
function createDeviceToolAdapter(
  deviceId: string,
  ws: import("ws").WebSocket,
  session: SessionContext,
  tool: McpTool,
): ChannelAgentTool {
  return {
    label: `esp32_${deviceId}_${tool.name}`,
    name: `esp32_${deviceId}_${tool.name}`,
    description:
      tool.description ??
      `ESP32 tool '${tool.name}' on device ${deviceId}.`,
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as unknown as ChannelAgentTool["parameters"],
    execute: async (_toolCallId, params) => {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        const result = await sendMcpCall(ws, session, tool.name, args);
        // Normalize: if result has { content: [...] } pass through, else wrap.
        if (
          result &&
          typeof result === "object" &&
          Array.isArray((result as { content?: unknown }).content)
        ) {
          const r = result as {
            content: Array<
              | { type: "text"; text: string }
              | { type: "image"; data: string; mimeType: string }
              | { type: "audio"; data: string; mimeType: string }
            >;
            isError?: boolean;
          };
          // Audio content → text (openclaw AgentToolResult doesn't support audio).
          const flat = r.content.map((c) =>
            c.type === "audio"
              ? { type: "text" as const, text: `[audio ${c.mimeType} ${c.data.length} chars base64]` }
              : c,
          ) as Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
          >;
          return { content: flat, details: r, isError: r.isError };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          details: result,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error calling esp32 tool '${tool.name}' on ${deviceId}: ${(err as Error).message}`,
            },
          ],
          details: { error: (err as Error).message },
          isError: true,
        };
      }
    },
  };
}

/**
 * M3.7.2: Channel-level factory that dynamically exposes all esp32
 * tools across all connected devices. The LLM can call
 * `esp32_<deviceId>_<toolName>` and it routes to the right device.
 *
 * Lazy: openclaw calls this at tool-discovery time. If no devices
 * are connected, returns an empty array (no LLM tools added).
 *
 * @see docs/sdk-research-v3.md §2.6 ChannelAgentToolFactory
 */
export const createEsp32DeviceToolRouter: ChannelAgentToolFactory = () => {
  const reg = getEsp32ToolRegistry();
  const out: ChannelAgentTool[] = [];
  for (const [deviceId, state] of reg.entries()) {
    const safeId = sanitizeDeviceId(deviceId);
    for (const tool of state.tools) {
      out.push(createDeviceToolAdapter(safeId, state.ws, state.session, tool));
    }
  }
  return out;
};

/** Re-export the payload builder so callers don't have to import protocol. */
export { _buildLlmToolsPayload as buildLlmToolsPayload };
