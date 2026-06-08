/**
 * Shared types for MCP handlers.
 *
 * XiaozhiContext is the per-esp32-connection context passed around
 * during message handling. It's heavier than SessionContext — it
 * includes ws, openclaw channelRuntime, and accumulated state.
 */

import type { SessionContext } from "../session.js";

export interface XiaozhiContext {
  // WebSocket + device identity
  deviceId: string;
  ws: import("ws").WebSocket;
  account: import("../config.js").XiaozhiAccount;

  // Session state
  session: SessionContext;

  // openclaw runtime
  channelRuntime: unknown;        // injected by openclaw in startAccount
  agentTools: unknown[];          // mutable list — M3.7 dynamic registration

  // Logging
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
}
