/**
 * Runtime adapter — openclaw hands us PluginRuntime + cfg at registration.
 *
 * M3.3b: adapt PluginRuntime → DirectDmRuntime shape so
 * dispatchInboundDirectDmWithRuntime can route esp32 text into the agent
 * loop. The cfg is captured here (instead of being read from the runtime
 * because PluginRuntime does not carry it) and stored module-level.
 *
 * M3.5/M3.6 will switch to higher-level channel-inbound helpers
 * (buildChannelInboundEventContext + dispatchChannelInboundReply) which
 * read directly from PluginRuntime.
 *
 * @see docs/sdk-research-v3.md §3.4 for the inbound dispatch flow.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk";

const { setRuntime: setXiaozhiRuntime, getRuntime: getXiaozhiRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "xiaozhi",
  errorMessage: "Xiaozhi runtime not initialized - plugin not registered",
});

let moduleCfg: OpenClawConfig | null = null;

export function setXiaozhiConfig(cfg: OpenClawConfig): void {
  moduleCfg = cfg;
}

export function getXiaozhiConfig(): OpenClawConfig | null {
  return moduleCfg;
}

/** DirectDmRuntime shim. Explicit return type to dodge TS2742 (cross-package inferred type). */
export function buildDirectDmRuntime(pluginRuntime: PluginRuntime): {
  channel: {
    routing: { resolveAgentRoute: (p: unknown) => unknown };
    session: {
      resolveStorePath: (...a: unknown[]) => string;
      readSessionUpdatedAt: (p: unknown) => number | undefined;
      recordInboundSession: (...a: unknown[]) => unknown;
    };
    reply: {
      resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => unknown;
      formatAgentEnvelope: (...a: unknown[]) => unknown;
      finalizeInboundContext: (...a: unknown[]) => unknown;
      dispatchReplyWithBufferedBlockDispatcher: PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
    };
  };
} {
  return {
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown): unknown =>
          (pluginRuntime.channel.routing.resolveAgentRoute as (p: unknown) => unknown)(params),
      },
      session: {
        resolveStorePath: ((...args: unknown[]) =>
          (pluginRuntime as unknown as {
            channel: { session: { resolveStorePath?: (...a: unknown[]) => string } };
          }).channel.session.resolveStorePath?.(...args) ?? "/tmp/openclaw/sessions") as never,
        readSessionUpdatedAt: ((params: unknown) =>
          (pluginRuntime as unknown as {
            channel: { session: { readSessionUpdatedAt?: (p: unknown) => number | undefined } };
          }).channel.session.readSessionUpdatedAt?.(params)) as never,
        recordInboundSession: ((...args: unknown[]) =>
          (pluginRuntime as unknown as {
            channel: { session: { recordInboundSession?: (...a: unknown[]) => unknown } };
          }).channel.session.recordInboundSession?.(...args)) as never,
      },
      reply: {
        resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) =>
          pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg),
        formatAgentEnvelope: ((...args: unknown[]) =>
          (pluginRuntime.channel.reply as unknown as { formatAgentEnvelope?: (...a: unknown[]) => unknown }).formatAgentEnvelope?.(...args)) as never,
        finalizeInboundContext: ((...args: unknown[]) =>
          (pluginRuntime.channel.reply as unknown as { finalizeInboundContext?: (...a: unknown[]) => unknown }).finalizeInboundContext?.(...args)) as never,
        dispatchReplyWithBufferedBlockDispatcher: pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  };
}

export { setXiaozhiRuntime, getXiaozhiRuntime };
