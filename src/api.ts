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

/**
 * M3.4g: get ASR/TTS sub-config from the top-level OpenClaw config.
 * openclaw's channel config schema validator STRIPS fields not declared in
 * channelConfigs.<id>.schema, so ctx.account doesn't carry asr/tts.
 * We read them from the raw cfg (which openclaw gives us in full).
 *
 * @see docs/plan-v3-xiaozhi-plugin.md §M3.4 (decision: read asr/tts from cfg)
 */
export function getXiaozhiAsrConfig(): {
  provider: "mock" | "sherpa_onnx" | "cloud";
  options?: Record<string, unknown>;
} | undefined {
  if (!moduleCfg) return undefined;
  const channel = (moduleCfg as { channels?: { xiaozhi?: { asr?: unknown } } })
    .channels?.xiaozhi;
  if (!channel) return undefined;
  return (channel as { asr?: { provider: "mock" | "sherpa_onnx" | "cloud"; options?: Record<string, unknown> } }).asr;
}

export function getXiaozhiTtsConfig(): {
  provider: "mock" | "edge" | "minimax" | "cloud";
  options?: Record<string, unknown>;
} | undefined {
  if (!moduleCfg) return undefined;
  const channel = (moduleCfg as { channels?: { xiaozhi?: { tts?: unknown } } })
    .channels?.xiaozhi;
  if (!channel) return undefined;
  return (channel as { tts?: { provider: "mock" | "edge" | "minimax" | "cloud"; options?: Record<string, unknown> } }).tts;
}

/**
 * v0.4.0-rc2 (batch 2): read the metrics feature flag from
 * `channels.xiaozhi.metricsEnabled`. Defaults to false (off) — the
 * metrics module is a no-op until explicitly enabled. We push this
 * into the metrics module from registerXiaozhiPlugin() so the helpers
 * have a single boolean to gate on.
 */
export function getMetricsEnabled(): boolean {
  const ch = getXiaozhiChannelConfig();
  if (!ch) return false;
  const v = (ch as { metricsEnabled?: unknown }).metricsEnabled;
  return v === true;
}

/**
 * v0.4.0-rc3 (batch 3): read the 4 grayscale feature flags.
 * All default to false. Each is independent — Allen can flip any
 * combination to validate the path in isolation.
 *
 *   useSileroVad     → server-side VAD via silero ONNX v4
 *   useStreamingAsr  → ASR via OnlineRecognizer pull-based
 *   useAccumulatePcm → inbound binary handler accumulates PCM (int16) directly
 *   useMultiFlagState→ enable 4 new flags on SessionContext
 */
function readFlag(ch: Record<string, unknown>, key: string): boolean {
  return (ch as Record<string, unknown>)[key] === true;
}

export function getUseSileroVad(): boolean {
  const ch = getXiaozhiChannelConfig();
  if (!ch) return false;
  return readFlag(ch, "useSileroVad");
}

export function getUseStreamingAsr(): boolean {
  const ch = getXiaozhiChannelConfig();
  if (!ch) return false;
  return readFlag(ch, "useStreamingAsr");
}

export function getUseAccumulatePcm(): boolean {
  const ch = getXiaozhiChannelConfig();
  if (!ch) return false;
  return readFlag(ch, "useAccumulatePcm");
}

export function getUseMultiFlagState(): boolean {
  const ch = getXiaozhiChannelConfig();
  if (!ch) return false;
  return readFlag(ch, "useMultiFlagState");
}

/**
 * v0.3.5: return the raw channels.xiaozhi config object so callers
 * can read non-schema-declared fields (wakeupWords / enableGreeting /
 * greeting — openclaw's schema validator strips these from
 * ctx.account). Use this for runtime knobs that the channel
 * schema doesn't model, NOT for asr/tts (use getXiaozhiAsrConfig
 * / getXiaozhiTtsConfig for those).
 */
export function getXiaozhiChannelConfig(): Record<string, unknown> | undefined {
  if (!moduleCfg) return undefined;
  const channel = (moduleCfg as { channels?: { xiaozhi?: unknown } })
    .channels?.xiaozhi;
  if (!channel || typeof channel !== "object") return undefined;
  return channel as Record<string, unknown>;
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
