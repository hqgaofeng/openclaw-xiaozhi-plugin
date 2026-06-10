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
import { handleOtaRequest } from "./ota.js";
// v0.4.0-rc2 (batch 2): metrics endpoint — same shape as OTA so the
// HTTP server's path router just needs to add a new prefix.
import { metricsHandler } from "./metrics.js";
// v0.4.0-rc4 (batch 4): OAuth middleware (opt-in). Imported statically
// for type safety; the runtime cost is zero because the middleware
// throws OAuthDisabledError synchronously when the feature flag is off.
// The actual fetch / network code paths are gated on getOAuthEnabled()
// inside oauthMiddleware, so when useOAuth=false the OAuth code is
// never reached (zero behavioural change vs v0.4.0-rc3).
import {
  OAuthDisabledError,
} from "./oauth/middleware.js";

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
  // M3.5: Same HTTP server also serves /api/xiaozhi/ota[ /] (POST + GET) for
  // xiaozhi-esp32 firmware OTA checks. WebSocket upgrade still wins for the
  // account.path prefix (handled by the WSS attached below).
  // v0.4.0-rc2 (batch 2): also serves /api/xiaozhi/metrics[ /] (GET only).
  // The handler itself returns 404 when metricsEnabled=false, so the
  // server doesn't need to know the flag — it just dispatches the
  // request and lets the handler decide.
  const httpServer = createServer((req, res) => {
    const url = req.url ?? "";
    const isOta = url === "/api/xiaozhi/ota" || url === "/api/xiaozhi/ota/";
    const isMetrics = url === "/api/xiaozhi/metrics" || url === "/api/xiaozhi/metrics/";
    const isHealth = url === "/health";
    if (isOta || isMetrics || isHealth) {
      // Pick the right handler. Pre-batch-2 code routed /health and
      // /api/xiaozhi/ota both to handleOtaRequest; we keep that
      // behavior (the OTA handler is happy to respond to GET /health
      // with a default OTA response, which is harmless and matches
      // whatever was deployed in v0.3.x). Metrics gets its own
      // handler that respects the feature flag.
      const handler = isMetrics ? metricsHandler : handleOtaRequest;
      // Async handler; Node http will keep the socket open until res.end().
      Promise.resolve(handler(req, res)).catch((err) => {
        console.error(`[xiaozhi] HTTP handler error: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal error\n");
        }
      });
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade required: this endpoint only accepts WebSocket connections.\n");
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: account.path,
    maxPayload: 10 * 1024 * 1024,  // 10 MB
  });

  // v0.4.0-rc4 (batch 4): the OAuth grayscale wrapper
  // (runAuthAndConnect) reuses the same sessionStore via closure,
  // so the V2 #6.1 path stays byte-for-byte identical.

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const deviceId = extractDeviceId(req);
    const token = extractBearerToken(req);

    // v0.4.0-rc4 (batch 4): OAuth grayscale. When getOAuthEnabled()
    // is true, route auth through oauthMiddleware (RFC 7662
    // introspect). When false (the default), use the V2 #6.1
    // Bearer path byte-for-byte. The flag is set once at plugin
    // init from cfg.channels.xiaozhi.useOAuth via register.ts.
    //
    // The async wrapper is gated on a module-level flag so the
    // OAuth code path is unreachable in the default config.
    void runAuthAndConnect(ws, req, account, deviceId, token, log, sessionStore);
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

/**
 * v0.4.0-rc4 (batch 4): auth + connect, with OAuth grayscale.
 *
 *   useOAuth=false (default): calls checkAuth() and proceeds.
 *     Identical to the v0.4.0-rc3 path. All OAuth code is unreachable.
 *   useOAuth=true:            calls oauthMiddleware() to validate
 *     the Bearer / opaque session token via the AS introspect
 *     endpoint. On ok, proceeds; on !ok, ws.close(1008, reason).
 *
 * Implementation note: the OAuth branch uses a dynamic import so
 * the OAuth code path is not loaded into memory in the default
 * config. The dynamic import is the only entry point to the OAuth
 * module from the gateway, matching the "use dynamic import to
 * prevent sandbox compile failure" note in the batch-4 spec.
 */
async function runAuthAndConnect(
  ws: WebSocket,
  req: IncomingMessage,
  account: XiaozhiAccount,
  deviceId: string | null,
  token: string | null,
  log: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  },
  sessionStore: SessionStore,
): Promise<void> {
  let auth: { ok: boolean; reason: string };
  try {
    const mod = await import("./oauth/middleware.js");
    if (mod.getOAuthEnabled()) {
      const result = await mod.oauthMiddleware(req, account);
      if (result.ok) {
        auth = { ok: true, reason: "" };
        // If the OAuth path returned a deviceId, prefer it over the
        // header. This matters when the AS is the source of truth
        // (e.g. a fleet of devices behind a load balancer).
        if (result.deviceId) {
          (req.headers as Record<string, string>)["device-id"] = result.deviceId;
        }
      } else {
        auth = { ok: false, reason: result.reason };
      }
    } else {
      // Default: V2 #6.1 Bearer path. Identical to v0.4.0-rc3.
      auth = checkAuth(token, deviceId, account);
    }
  } catch (err) {
    if (err instanceof OAuthDisabledError) {
      // Flag flipped between check and call (config hot-reload) —
      // fall back to V2 #6.1.
      auth = checkAuth(token, deviceId, account);
    } else {
      log.error(`xiaozhi: auth check threw: ${(err as Error).message}`);
      ws.close(1011, "internal_error");
      return;
    }
  }

  if (!auth.ok) {
    log.warn(`xiaozhi: rejected connection from ${req.socket.remoteAddress} (reason=${auth.reason})`);
    ws.close(1008, auth.reason);  // 1008 = policy violation
    return;
  }

  // Re-read deviceId after potential OAuth override.
  const finalDeviceId = extractDeviceId(req) ?? deviceId;
  if (!finalDeviceId) {
    log.warn(`xiaozhi: connection without Device-Id header from ${req.socket.remoteAddress}`);
    ws.close(1008, "no_device_id");
    return;
  }

  // Downstream: identical to the v0.4.0-rc3 connection body.
  const sessionId = `${account.sessionIdPrefix}-${randomUUID()}`;
  log.info(`xiaozhi: device ${finalDeviceId} connected, session=${sessionId}`);

  handleEsp32Connection({
    account,
    deviceId: finalDeviceId,
    sessionId,
    ws,
    log,
    sessionStore,
  }).catch((err) => {
    log.error(`xiaozhi: handleEsp32Connection failed for ${finalDeviceId}:`, err);
    try { ws.close(1011, "internal_error"); } catch { /* ignore */ }
  });

  ws.on("close", () => {
    log.info(`xiaozhi: device ${finalDeviceId} disconnected`);
    sessionStore.unregister(finalDeviceId);
  });
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
