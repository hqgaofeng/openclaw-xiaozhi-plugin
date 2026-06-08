/**
 * Plugin-level OpenClawPluginApi.register() entry.
 *
 * M3.5: registers the xiaozhi-esp32 OTA HTTP route via openclaw's
 * registerHttpRoute() contract. The channel entry itself doesn't have
 * access to OpenClawPluginApi (channel entries are per-channel scope;
 * OTA is a plugin-level concern that needs the global plugin api).
 *
 * The entry contract (defineBundledChannelEntry) supports a
 * `registerFull` hook that fires at plugin activation with the
 * OpenClawPluginApi — that's where we hook in. See
 * channel-entry-contract-BeZBmQLV.js for the field.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { handleOtaRequest } from "./ota.js";

/**
 * Register plugin-level concerns that don't fit into a ChannelPlugin
 * (e.g. HTTP routes, lifecycle hooks, etc.).
 *
 * Wired via defineBundledChannelEntry({ registerFull: (api) => registerXiaozhiPlugin(api) })
 * in src/index.ts.
 */
export function registerXiaozhiPlugin(api: OpenClawPluginApi): void {
  // M3.5: xiaozhi-esp32 OTA endpoint (V2 #8 移植).
  // Path matches V2 8001 endpoint: /api/xiaozhi/ota/ (and no-trailing-slash
  // variant) so nginx routing doesn't need any changes.
  api.registerHttpRoute({
    path: "/api/xiaozhi/ota",
    auth: "plugin",
    handler: handleOtaRequest,
  });
  api.registerHttpRoute({
    path: "/api/xiaozhi/ota/",
    auth: "plugin",
    handler: handleOtaRequest,
  });
  console.log("[xiaozhi] registered OTA routes: /api/xiaozhi/ota, /api/xiaozhi/ota/");
}
