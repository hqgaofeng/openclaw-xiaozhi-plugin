/**
 * Runtime store — openclaw hands us its PluginRuntime at registration.
 *
 * M3.4 will use this in handleEsp32Connection to dispatch inbound
 * text/audio to the agent loop.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setXiaozhiRuntime, getRuntime: getXiaozhiRuntime } = createPluginRuntimeStore({
  pluginId: "xiaozhi",
  errorMessage: "Xiaozhi runtime not initialized - plugin not registered",
});

export { setXiaozhiRuntime, getXiaozhiRuntime };
