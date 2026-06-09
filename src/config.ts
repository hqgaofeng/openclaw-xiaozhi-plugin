/**
 * ChannelConfigAdapter + XiaozhiAccount types.
 *
 * XiaozhiAccount is the resolved config for one xiaozhi instance.
 * XiaozhiConfig is the schema validated before resolve.
 *
 * V2 config (config.yaml) → V3 config (channels.xiaozhi.* in openclaw.json)
 *
 * M3.2 阶段: 实现最小 listAccountIds + resolveAccount (从 openclaw.json 读)
 * M3.4 阶段: 用 createTopLevelChannelConfigAdapter 替换手写实现（如果需要）
 *
 * @see docs/sdk-research-v3.md §4.2 for the 1:1 translation of the
 *   xiaozhi-bridge config.yaml fields.
 */

import type { ChannelConfigAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { ChannelConfigSchema, OpenClawConfig } from "openclaw/plugin-sdk";

export interface XiaozhiAccount {
  accountId: string;
  enabled: boolean;

  // WSS server config
  host: string;
  port: number;
  path: string;
  tls:
    | { enabled: false }
    | { enabled: true; cert: string; key: string };

  // Auth (V2 #6.1)
  authTokens: Record<string, string>;
  globalAuthToken: string;

  // Session
  sessionIdPrefix: string;

  // M3.4: ASR / TTS provider config (parallel to V2 bridge config.yaml)
  asr?: {
    provider: "mock" | "sherpa_onnx" | "cloud";
    options?: Record<string, unknown>;
  };
  tts?: {
    provider: "mock" | "edge" | "minimax" | "cloud";
    options?: Record<string, unknown>;
  };

  // v0.3.5: wake-word short-circuit (mirrors official xiaozhi-esp32-server
  //   core/handle/textHandler/listenMessageHandler.py: when the esp32
  //   AFE detects one of these phrases, the official backend
  //   - sends STT echo for display,
  //   - replies with a fixed greeting ("嘿，你好呀") instead of
  //     dispatching to the LLM, OR
  //   - sends tts=stop and skips the reply entirely if enable_greeting=false.
  //   This prevents the "every wake-up says the same reply twice" symptom
  //   we were seeing (plugin previously dispatched the wake word to the
  //   agent loop, which always answered "我是贾维斯" — and the esp32 mic
  //   picked up the TTS echo on the next VAD cycle, triggering a second
  //   identical reply).
  wakeupWords?: string[];
  enableGreeting?: boolean;
  greeting?: string;
}

export interface XiaozhiConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  tls: { enabled: boolean; cert: string; key: string };
  authTokens: Record<string, string>;
  globalAuthToken: string;
  sessionIdPrefix: string;

  // M3.4: ASR / TTS provider config (parallel to V2 bridge config.yaml)
  asr?: {
    provider: "mock" | "sherpa_onnx" | "cloud";
    options?: Record<string, unknown>;
  };
  tts?: {
    provider: "mock" | "edge" | "minimax" | "cloud";
    options?: Record<string, unknown>;
  };

  // v0.3.5: wake-word short-circuit
  wakeupWords?: string[];
  enableGreeting?: boolean;
  greeting?: string;
}

export const DEFAULT_CONFIG: Omit<XiaozhiConfig, "accountId"> = {
  enabled: true,
  host: "0.0.0.0",
  port: 18789,
  path: "/xiaozhi/v1/",
  tls: { enabled: false, cert: "", key: "" },
  authTokens: {},
  globalAuthToken: "",
  sessionIdPrefix: "xiaozhi",
};

/** Single-account config (V2 model: one xiaozhi instance per gateway). */
export const DEFAULT_ACCOUNT_ID = "default";

/** Read xiaozhi config from the openclaw `channels.xiaozhi.*` section. */
export function readXiaozhiConfig(raw: unknown): XiaozhiConfig {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_CONFIG };
  }
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled !== false, // default true
    host: typeof r.host === "string" ? r.host : DEFAULT_CONFIG.host,
    port: typeof r.port === "number" && r.port > 0 && r.port < 65536
      ? r.port
      : DEFAULT_CONFIG.port,
    path: typeof r.path === "string" ? r.path : DEFAULT_CONFIG.path,
    tls: typeof r.tls === "object" && r.tls !== null
      ? (r.tls as { enabled: boolean; cert: string; key: string })
      : DEFAULT_CONFIG.tls,
    authTokens: typeof r.authTokens === "object" && r.authTokens !== null
      ? (r.authTokens as Record<string, string>)
      : {},
    globalAuthToken: typeof r.globalAuthToken === "string"
      ? r.globalAuthToken
      : "",
    sessionIdPrefix: typeof r.sessionIdPrefix === "string"
      ? r.sessionIdPrefix
      : DEFAULT_CONFIG.sessionIdPrefix,
    // v0.3.5: wake-word short-circuit (mirrors xiaozhi-esp32-server
    //   config.yaml wakeup_words + enable_greeting).
    wakeupWords: Array.isArray(r.wakeupWords)
      ? (r.wakeupWords as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined,
    enableGreeting: typeof r.enableGreeting === "boolean"
      ? r.enableGreeting
      : true, // default: greet (matches official)
    greeting: typeof r.greeting === "string"
      ? r.greeting
      : "嘿，你好呀", // default: matches official
  };
}

/** Resolve a XiaozhiAccount from openclaw config. */
export function resolveAccount(rawChannels: unknown, accountId: string = DEFAULT_ACCOUNT_ID): XiaozhiAccount {
  if (typeof rawChannels !== "object" || rawChannels === null) {
    return {
      accountId,
      ...DEFAULT_CONFIG,
      tls: { enabled: false },
    };
  }
  const channels = rawChannels as Record<string, unknown>;
  const xiaozhiRaw = channels.xiaozhi;
  const config = readXiaozhiConfig(xiaozhiRaw);
  return {
    accountId,
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    path: config.path,
    tls: config.tls.enabled
      ? { enabled: true, cert: config.tls.cert, key: config.tls.key }
      : { enabled: false },
    authTokens: config.authTokens,
    globalAuthToken: config.globalAuthToken,
    sessionIdPrefix: config.sessionIdPrefix,
    wakeupWords: config.wakeupWords,
    enableGreeting: config.enableGreeting,
    greeting: config.greeting,
  };
}

/** List all configured xiaozhi account IDs. V2 model: only "default". */
export function listAccountIds(_rawChannels: unknown): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function createXiaozhiConfigAdapter(): ChannelConfigAdapter<XiaozhiAccount> {
  return {
    listAccountIds: (cfg: OpenClawConfig) => {
      const channels = (cfg as unknown as { channels?: unknown }).channels;
      return listAccountIds(channels);
    },
    resolveAccount: (cfg: OpenClawConfig, accountId: string) => {
      const channels = (cfg as unknown as { channels?: unknown }).channels;
      return resolveAccount(channels, accountId);
    },
    isConfigured: (account: XiaozhiAccount) => account.enabled,
    unconfiguredReason: () => "xiaozhi account is not enabled",
    describeAccount: (account: XiaozhiAccount) => ({
      accountId: account.accountId,
      name: `${account.host}:${account.port}${account.path}`,
      enabled: account.enabled,
    }),
  } as unknown as ChannelConfigAdapter<XiaozhiAccount>;
}

export function createXiaozhiConfigSchema(): ChannelConfigSchema {
  // M3.4 will use the zod schema we already defined in protocol.ts.
  return {} as ChannelConfigSchema;
}
