/**
 * ChannelGatewayAdapter — startAccount implementation.
 *
 * Starts a wss:// server bound to `host:port${path}` and routes
 * incoming esp32 connections to handleEsp32Connection (in inbound.ts).
 *
 * Auth: V2 #6.1 logic
 *   - per-device token (from Authorization: Bearer <token>) checked against
 *     account.authTokens[deviceId] first
 *   - falls back to account.globalAuthToken
 *   - if both empty, auth is disabled (V2 #5 compatibility)
 *
 * @see docs/sdk-research-v3.md §2.2 for the SMS plugin example we adapt.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChannelGatewayAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { XiaozhiAccount } from "./config.js";
import { handleEsp32Connection } from "./inbound.js";
import { getDeviceRegistry } from "./tools.js";
import { setXiaozhiConfig } from "./api.js";

export interface GatewayContext {
  cfg: unknown;
  account: XiaozhiAccount;
  abortSignal: AbortSignal;
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
}

export interface SessionStore {
  register(deviceId: string, session: unknown): void;
  unregister(deviceId: string): void;
  list(): Array<{ deviceId: string; sessionId: string; state: string; lastActivityAt: number }>;
}

/** Extract the deviceId from the Device-Id header (xiaozhi protocol). */
export function extractDeviceId(req: IncomingMessage): string | null {
  const deviceId = req.headers["device-id"];
  if (typeof deviceId === "string" && deviceId.length > 0) {
    return deviceId;
  }
  if (Array.isArray(deviceId) && deviceId.length > 0) {
    return deviceId[0];
  }
  return null;
}

/** Extract bearer token from Authorization header. */
export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1] : null;
}

/**
 * V2 #6.1 / V2 #6.2 auth check.
 * Returns { ok, reason }.
 */
export function checkAuth(
  token: string | null,
  deviceId: string | null,
  account: XiaozhiAccount,
): { ok: boolean; reason: string } {
  const hasPerDevice = Object.keys(account.authTokens).length > 0;
  const hasGlobal = account.globalAuthToken.length > 0;

  // No auth configured → V2 #5: allow everything
  if (!hasPerDevice && !hasGlobal) {
    return { ok: true, reason: "" };
  }

  if (!token) {
    return { ok: false, reason: "no_authorization_header" };
  }

  // Per-device token takes precedence
  if (deviceId && account.authTokens[deviceId] === token) {
    return { ok: true, reason: "" };
  }

  // Global token fallback
  if (hasGlobal && account.globalAuthToken === token) {
    return { ok: true, reason: "" };
  }

  return { ok: false, reason: "wrong_token" };
}

export async function startWssServer(
  account: XiaozhiAccount,
  sessionStore: SessionStore,
  log: GatewayContext["log"],
  abortSignal: AbortSignal,
): Promise<HttpServer> {
  // For TLS support (M3.4), wrap with https.Server. For M3.2/M3.3, plain ws.
  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade required: this endpoint only accepts WebSocket connections.\n");
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: account.path,
    maxPayload: 10 * 1024 * 1024,  // 10 MB
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const deviceId = extractDeviceId(req);
    const token = extractBearerToken(req);
    const auth = checkAuth(token, deviceId, account);

    if (!auth.ok) {
      log.warn(`xiaozhi: rejected connection from ${req.socket.remoteAddress} (reason=${auth.reason})`);
      ws.close(1008, auth.reason);  // 1008 = policy violation
      return;
    }

    if (!deviceId) {
      log.warn(`xiaozhi: connection without Device-Id header from ${req.socket.remoteAddress}`);
      ws.close(1008, "no_device_id");
      return;
    }

    const sessionId = `${account.sessionIdPrefix}-${randomUUID()}`;
    log.info(`xiaozhi: device ${deviceId} connected, session=${sessionId}`);

    handleEsp32Connection({
      account,
      deviceId,
      sessionId,
      ws,
      log,
      sessionStore,
    }).catch((err) => {
      log.error(`xiaozhi: handleEsp32Connection failed for ${deviceId}:`, err);
      try { ws.close(1011, "internal_error"); } catch { /* ignore */ }
    });

    ws.on("close", () => {
      log.info(`xiaozhi: device ${deviceId} disconnected`);
      sessionStore.unregister(deviceId);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(account.port, account.host, () => {
      httpServer.off("error", reject);
      log.info(`xiaozhi: wss server listening on ws://${account.host}:${account.port}${account.path}`);
      resolve();
    });
  });

  // Shutdown on abort
  const onAbort = () => {
    log.info("xiaozhi: shutting down wss server");
    wss.close();
    httpServer.close();
  };
  if (abortSignal.aborted) {
    onAbort();
  } else {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  return httpServer;
}

export function createXiaozhiGatewayAdapter(): ChannelGatewayAdapter<XiaozhiAccount> {
  return {
    startAccount: async (ctx) => {
      const log = (ctx as unknown as GatewayContext).log ?? {
        info: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
      };
      const abortSignal: AbortSignal = (ctx as unknown as GatewayContext).abortSignal ?? new AbortController().signal;
      const account: XiaozhiAccount = (ctx as unknown as GatewayContext).account;
      const cfg: unknown = (ctx as unknown as GatewayContext).cfg;

      // Shared session store (across all devices in this account).
      // M3.2: in-memory only + globally exported via tools.getDeviceRegistry().
      // M3.4: backed by openclaw device store.
      const sessionStore: SessionStore = createGlobalSessionStore();

      await startWssServer(account, sessionStore, log, abortSignal);
      // M3.3b: capture cfg module-level so dispatchInboundDirectDmWithRuntime
      // can resolve envelope format options.
      setXiaozhiConfig(cfg as never);
      // Block until abort
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) resolve();
        else abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  } as ChannelGatewayAdapter<XiaozhiAccount>;
}

// ---- Session store: shared with tools.ts xiaozhi_list_devices ----

export function createGlobalSessionStore(): SessionStore {
  const registry = getDeviceRegistry();
  return {
    register(deviceId, session) {
      const s = session as { sessionId: string; state: string; lastActivityAt: number };
      registry.set(deviceId, { deviceId, sessionId: s.sessionId, state: s.state, lastActivityAt: s.lastActivityAt });
    },
    unregister(deviceId) {
      registry.delete(deviceId);
    },
    list() {
      return Array.from(registry.values());
    },
  };
}
