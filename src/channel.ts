/**
 * Main ChannelPlugin assembly.
 *
 * 17 fields from openclaw SDK:
 *   id, meta, capabilities, defaults, reload, config, configSchema,
 *   setupWizard, setup, pairing, security, groups, mentions, outbound,
 *   status, gateway, auth, approvalCapability, elevated, commands,
 *   lifecycle, secrets, allowlist, doctor, bindings, conversationBindings,
 *   streaming, threading, message, messaging, agentPrompt, directory,
 *   resolver, actions, heartbeat, agentTools
 *
 * We implement 8 core fields (rest use openclaw defaults):
 *   1. id, 2. meta, 3. capabilities,
 *   4. config + configSchema,
 *   5. gateway (startAccount),
 *   6. messaging (inbound dispatch),
 *   7. outbound (TTS to esp32),
 *   8. agentTools (M3.7 esp32 tools),
 *   + streaming (block streaming defaults)
 *
 * @see docs/sdk-research-v3.md §2.1 for the full 17-field type.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type {
  ChannelMeta,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelStreamingAdapter,
} from "openclaw/plugin-sdk/channel-runtime";
import type { XiaozhiAccount } from "./config.js";
import { createXiaozhiConfigAdapter, createXiaozhiConfigSchema } from "./config.js";
import { createXiaozhiGatewayAdapter } from "./gateway.js";
import { createXiaozhiMessagingAdapter } from "./inbound.js";
import { createXiaozhiOutboundAdapter } from "./outbound.js";
import { createListDevicesTool, createEsp32DeviceToolRouter } from "./mcp/tools.js";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-runtime";

const META: ChannelMeta = {
  id: "xiaozhi" as ChannelMeta["id"],
  label: "Xiaozhi Device",
  selectionLabel: "Xiaozhi Device",
  docsPath: "/docs/channels/xiaozhi",
  blurb: "ESP32 xiaozhi protocol as a native openclaw channel",
  systemImage: "mic.fill",
  markdownCapable: false,
};

const CAPABILITIES: ChannelCapabilities = {
  chatTypes: ["direct"],
  media: true,
  tts: {
    voice: {
      synthesisTarget: "audio-file",
    },
  },
};

export function createXiaozhiChannelPlugin(): ChannelPlugin<XiaozhiAccount> {
  return {
    // ---- 标识 (3) ----
    id: "xiaozhi" as ChannelPlugin["id"],
    meta: META,
    capabilities: CAPABILITIES,

    // ---- 配置 (5) ----
    config: createXiaozhiConfigAdapter() as ChannelConfigAdapter<XiaozhiAccount>,
    configSchema: createXiaozhiConfigSchema(),

    // ---- 生命周期 (核心 5) ----
    gateway: createXiaozhiGatewayAdapter() as ChannelGatewayAdapter<XiaozhiAccount>,
    messaging: createXiaozhiMessagingAdapter() as ChannelMessagingAdapter,
    outbound: createXiaozhiOutboundAdapter() as ChannelOutboundAdapter,
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 50, idleMs: 200 },
    } as ChannelStreamingAdapter,
    // M3.7.2: agentTools is a ChannelAgentToolFactory (lazy) that
    // enumerates all currently-registered esp32 devices and exposes
    // each device's tool list as LLM-callable tools named
    // `esp32_<deviceId>_<toolName>`. xiaozhi_list_devices stays
    // static. openclaw calls createEsp32DeviceToolRouter at tool
    // discovery time, so the tool list updates as devices connect.
    agentTools: [createListDevicesTool(), createEsp32DeviceToolRouter] as unknown as ChannelAgentTool[],
  };
}
