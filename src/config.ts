/**
 * ChannelConfigAdapter + XiaozhiAccount types.
 *
 * XiaozhiAccount is the resolved config for one xiaozhi instance.
 * XiaozhiConfig is the schema validated before resolve.
 *
 * @see docs/sdk-research-v3.md §4.2 for the 1:1 translation of the
 *   xiaozhi-bridge config.yaml fields.
 */

import type { ChannelConfigAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

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

  // Auth
  authTokens: Record<string, string>;
  globalAuthToken: string;

  // Session
  sessionIdPrefix: string;
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
}

export function createXiaozhiConfigAdapter(): ChannelConfigAdapter<XiaozhiAccount> {
  // TODO(M3.2): implement resolveAccount / listAccounts
  //   - Read channels.xiaozhi.* from openclaw.json
  //   - Build XiaozhiAccount from raw config
  //   - Default port 18789, path /xiaozhi/v1/
  return {} as ChannelConfigAdapter<XiaozhiAccount>;
}

export function createXiaozhiConfigSchema(): ChannelConfigSchema {
  // TODO(M3.2): implement zod-like schema for the 8 fields
  return {} as ChannelConfigSchema;
}
