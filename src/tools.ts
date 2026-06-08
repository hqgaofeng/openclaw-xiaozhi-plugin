/**
 * openclaw agent tool factory.
 *
 * 1 example tool: xiaozhi_list_devices (shows up immediately in M3.2).
 * M3.7 will add dynamic tool registration for esp32-reported tools.
 *
 * @see docs/sdk-research-v3.md §2.6 (ChannelAgentToolFactory)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2 (M3.7)
 */

import type { ChannelAgentTool } from "openclaw/plugin-sdk";

export function createListDevicesTool(): ChannelAgentTool {
  return {
    label: "xiaozhi_list_devices",
    name: "xiaozhi_list_devices",
    description: "List all connected ESP32 xiaozhi devices with their session_id, state, and last_seen timestamp.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_toolCallId, _params, _signal, _onUpdate) => {
      // TODO(M3.2): implement
      //   - Query the global sessions map
      //   - Return AgentToolResult<unknown>
      return {
        content: [{ type: "text", text: "[]" }],
        details: [],
      };
    },
  };
}
