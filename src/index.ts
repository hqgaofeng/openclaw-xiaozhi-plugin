/**
 * openclaw-xiaozhi-plugin entry point
 *
 * Bundled channel entry contract (per openclaw 2026.6.1 channel-entry-contract).
 * openclaw loads `plugin` + `runtime` lazily via specifier/exportName pairs.
 *
 * The actual `ChannelPlugin<XiaozhiAccount>` lives in plugin-xiaozhi.ts.
 * The runtime setter lives in api.ts (for M3.4 dispatch wiring).
 *
 * @see docs/sdk-research-v3.md §3 for field-by-field design.
 * @see node_modules/openclaw/dist/channel-entry-contract-BeZBmQLV.js for contract.
 */

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "xiaozhi",
  name: "Xiaozhi Device Channel",
  description: "ESP32 xiaozhi protocol as a native openclaw channel",
  importMetaUrl: import.meta.url,

  plugin: {
    specifier: "./plugin-xiaozhi.js",
    exportName: "xiaozhiPlugin",
  },

  runtime: {
    specifier: "./api.js",
    exportName: "setXiaozhiRuntime",
  },
});
