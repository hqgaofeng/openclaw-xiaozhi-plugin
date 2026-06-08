/**
 * openclaw agent tool factory.
 *
 * M3.2: xiaozhi_list_devices uses a global in-memory session store.
 *       The store is populated by gateway.ts when devices connect.
 * M3.4: store will be backed by openclaw's device store / channelRuntime.
 *
 * M3.7: dynamic esp32 tool registration lives in mcp/inbound.ts.
 *
 * @see docs/sdk-research-v3.md §2.6 (ChannelAgentToolFactory)
 * @see docs/plan-v3-xiaozhi-plugin.md §8.2 (M3.7)
 */

import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-runtime";

export interface DeviceInfo {
  deviceId: string;
  sessionId: string;
  state: string;
  lastActivityAt: number;
}

export type DeviceRegistry = Map<string, DeviceInfo>;

const globalRegistry: DeviceRegistry = new Map();

/** Get the global device registry (M3.2: in-process singleton). */
export function getDeviceRegistry(): DeviceRegistry {
  return globalRegistry;
}

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
    execute: async (_toolCallId, _params, _signal, _onUpdate) => {
      const devices = Array.from(globalRegistry.values());
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
