/**
 * Channel plugin object (assembled).
 *
 * This file exports the actual `ChannelPlugin<XiaozhiAccount>` instance.
 * openclaw loads it lazily via `defineBundledChannelEntry`'s
 * `plugin.specifier + exportName` mechanism.
 */

import { createXiaozhiChannelPlugin } from "./channel.js";
import { setOpenClawAgentToolsProvider } from "./mcp/inbound.js";
import { createListDevicesTool, createEsp32DeviceToolRouter } from "./mcp/tools.js";

export const xiaozhiPlugin = createXiaozhiChannelPlugin();

// v0.3.7 (M4 fix): install a *provider* for the openclaw agent tool
// list, not a static snapshot. The provider is invoked on every
// esp32 tools/list / tools/call request, so the tool list stays
// live as devices connect/disconnect.
setOpenClawAgentToolsProvider(() => {
  const out: Array<{
    name: string;
    description?: string;
    inputSchema?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
    execute: (params: Record<string, unknown>) => Promise<{
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      >;
      isError?: boolean;
    }>;
  }> = [];

  // Static tool: xiaozhi_list_devices
  const listTool = createListDevicesTool();
  out.push({
    name: listTool.name,
    description: listTool.description,
    inputSchema: { type: "object", properties: {} },
    execute: async (params) => {
      const r = await listTool.execute("tcid-list", params);
      return {
        content: r.content as Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        >,
        isError: r.isError,
      };
    },
  });

  // Per-device tools: enumerated from the live esp32 registry
  // every time the provider is called. This means a device that
  // just connected (and reported its tools/list) shows up
  // immediately in subsequent esp32 tools/call calls.
  for (const t of createEsp32DeviceToolRouter()) {
    out.push({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: "object"; properties?: Record<string, unknown>; required?: string[] } | undefined,
      execute: async (params) => {
        const r = await t.execute("tcid-device", params);
        return {
          content: r.content as Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
          >,
          isError: r.isError,
        };
      },
    });
  }

  return out;
});
