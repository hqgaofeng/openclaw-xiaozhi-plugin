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
import { metricsHandler, setMetricsEnabled as setMetricsModuleEnabled } from "./metrics.js";
import { setOAuthEnabled } from "./oauth/middleware.js";
import { getMetricsEnabled as getMetricsEnabledFromCfg, getOAuthEnabled as getOAuthEnabledFromCfg, getUseRetry as getUseRetryFromCfg } from "./api.js";

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

  // v0.4.0-rc2 (batch 2): metrics endpoint. Mirrors OTA in shape and
  // auth. Disabled by default — when channels.xiaozhi.metricsEnabled
  // is false (the default), the handler returns 404 and the route
  // effectively doesn't exist. When enabled, returns a JSON snapshot
  // of Counters / Histograms / Gauges + uptime.
  api.registerHttpRoute({
    path: "/api/xiaozhi/metrics",
    auth: "plugin",
    handler: metricsHandler,
  });
  api.registerHttpRoute({
    path: "/api/xiaozhi/metrics/",
    auth: "plugin",
    handler: metricsHandler,
  });
  // Push the cfg-derived flag into the metrics module so its helpers
  // gate on a single boolean. Done once at plugin registration;
  // the cfg is captured by setXiaozhiConfig() before this point.
  setMetricsModuleEnabled(getMetricsEnabledFromCfg());

  // v0.4.0-rc4 (batch 4): sync the OAuth and retry feature flags
  // from cfg to their respective module-level state. Same pattern
  // as metrics: one-time push at plugin init.
  setOAuthEnabled(getOAuthEnabledFromCfg());

  console.log(
    "[xiaozhi] registered OTA + metrics routes: " +
    "/api/xiaozhi/ota, /api/xiaozhi/ota/, " +
    "/api/xiaozhi/metrics, /api/xiaozhi/metrics/",
  );
  console.log(
    `[xiaozhi] metricsEnabled=${getMetricsEnabledFromCfg()} ` +
    `(disabled → /api/xiaozhi/metrics returns 404)`,
  );
  console.log(
    `[xiaozhi] useOAuth=${getOAuthEnabledFromCfg()} ` +
    `useRetry=${getUseRetryFromCfg()} ` +
    `(disabled → OAuth/retry code paths unreachable)`,
  );
}
