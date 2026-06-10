/**
 * src/oauth/middleware.ts — v0.4.0-rc4 (batch 4) — OAuth-based auth check.
 *
 * Drop-in replacement for `checkAuth` when the gateway is configured
 * with `channels.xiaozhi.useOAuth = true`. Validates a Bearer (or
 * opaque session) token by calling the OAuth Authorization Server's
 * token introspection endpoint (RFC 7662), then returns the deviceId
 * and scopes.
 *
 * ## Feature flag
 *
 * `getOAuthEnabled()` (mirrors the metricsEnabled pattern) defaults
 * to false. When false, the middleware throws OAuthDisabledError,
 * forcing the gateway to fall back to the V2 #6.1 Bearer path. The
 * throw is intentional — it's louder than a silent return, and
 * matches the spec's "灰度开关 false 时: throw" rule.
 *
 * ## Introspection call
 *
 * We POST to the AS's introspectUrl with
 *   `token=<opaque>&token_type_hint=access_token&client_id=...&client_secret=...`
 * per RFC 7662 §2.1. The AS returns {active: true/false, ...}. When
 * active=false, we reject with reason "token_inactive".
 *
 * The 5xx + network error handling reuses the same defaultRetryOn
 * predicates as the OAuth client. A failed introspect after retries
 * returns `{ok: false, reason: "introspect_failed"}` (not a throw)
 * so the gateway can `ws.close(1008, reason)` cleanly.
 *
 * @see src/oauth/client.ts
 * @see src/oauth/types.ts
 * @see src/gateway.ts (calls this when useOAuth=true)
 */

import type { IncomingMessage } from "node:http";
import { OAuthClient, type OAuthClientOptions } from "./client.js";
import { OAuthError, type OAuthConfig, type IntrospectResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of an OAuth middleware check. */
export type OAuthAuthResult =
  | { ok: true; deviceId?: string; scopes?: string[] }
  | { ok: false; reason: string };

/** Thrown when the feature flag is OFF. */
export class OAuthDisabledError extends Error {
  constructor() {
    super("OAuth is not enabled (channels.xiaozhi.useOAuth=false). Use V2 #6.1 Bearer auth.");
    this.name = "OAuthDisabledError";
    Object.setPrototypeOf(this, OAuthDisabledError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Feature flag (mirrors metricsEnabled pattern)
// ---------------------------------------------------------------------------

let oauthEnabledFlag = false;

export function getOAuthEnabled(): boolean {
  return oauthEnabledFlag;
}

export function setOAuthEnabled(enabled: boolean): void {
  oauthEnabledFlag = enabled;
}

// ---------------------------------------------------------------------------
// Client singleton + injection point
// ---------------------------------------------------------------------------

let clientInstance: OAuthClient | null = null;

/**
 * Replace the OAuth client. Production code calls this from the
 * register function (after reading cfg). Tests call it to inject a
 * mock-backed client.
 */
export function setOAuthClient(client: OAuthClient | null): void {
  clientInstance = client;
}

/**
 * Get the current OAuth client. If none is set yet, builds a default
 * one from environment variables (MINIMAX_OAUTH_* is the xiaozhi
 * convention; we don't have a real AS in this commit, so the
 * default config is for documentation only — the feature flag is
 * off by default, so this path is unreachable in production).
 */
export function getOAuthClient(): OAuthClient {
  if (clientInstance) return clientInstance;
  const cfg: OAuthConfig = {
    clientId: process.env.XIAOZHI_OAUTH_CLIENT_ID ?? "xiaozhi-client",
    clientSecret: process.env.XIAOZHI_OAUTH_CLIENT_SECRET ?? "",
    tokenUrl: process.env.XIAOZHI_OAUTH_TOKEN_URL ?? "https://auth.example.com/oauth/token",
    introspectUrl: process.env.XIAOZHI_OAUTH_INTROSPECT_URL ?? "https://auth.example.com/oauth/introspect",
    scope: process.env.XIAOZHI_OAUTH_SCOPE ?? "device.read device.write",
  };
  const opts: OAuthClientOptions = {};
  clientInstance = new OAuthClient(cfg, opts);
  return clientInstance;
}

/** Test-only: wipe the singleton. */
export function resetOAuthClientForTest(): void {
  clientInstance = null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Validate the OAuth Bearer / opaque session token from the request.
 * Returns a structured result suitable for `ws.close(1008, reason)`.
 *
 * @throws OAuthDisabledError when the feature flag is OFF. This
 *         signals to the caller to use the V2 #6.1 path instead.
 */
export async function oauthMiddleware(
  req: IncomingMessage,
  _account: unknown,
): Promise<OAuthAuthResult> {
  if (!getOAuthEnabled()) {
    throw new OAuthDisabledError();
  }

  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, reason: "no_authorization_header" };
  }

  const client = getOAuthClient();
  try {
    const result = await introspectToken(client, token);
    if (!result.active) {
      return { ok: false, reason: "token_inactive" };
    }
    return {
      ok: true,
      deviceId: result.device_id,
      scopes: result.scope
        ? result.scope.split(/\s+/).filter((s) => s.length > 0)
        : undefined,
    };
  } catch (err) {
    if (err instanceof OAuthError) {
      return { ok: false, reason: `introspect_failed:${err.code}` };
    }
    return { ok: false, reason: "introspect_failed" };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * POST the token to the AS introspect endpoint via the OAuth client's
 * fetchImpl (so we share the same retry / network handling).
 */
async function introspectToken(
  client: OAuthClient,
  token: string,
): Promise<IntrospectResponse> {
  const cfg = (client as unknown as { cfg: OAuthConfig }).cfg;
  if (!cfg.introspectUrl) {
    throw new OAuthError(
      "introspect_unconfigured",
      "OAuth client has no introspectUrl configured",
    );
  }
  const body = new URLSearchParams({
    token,
    token_type_hint: "access_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  // Reach into the client's fetchImpl so we don't re-implement the
  // retry / network policy. (The OAuthClient doesn't expose introspect
  // as a method — the only public surface is getAccessToken / withToken.
  // Doing it this way keeps the retry policy identical to the token
  // endpoint.)
  const fetchImpl = (client as unknown as { fetchImpl: typeof globalThis.fetch }).fetchImpl;
  const res = await fetchImpl(cfg.introspectUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (res.status >= 500) {
    let txt = "";
    try { txt = await res.text(); } catch { /* */ }
    throw new OAuthError(
      "introspect_5xx",
      `introspect endpoint returned ${res.status}: ${txt.slice(0, 200)}`,
      { status: res.status },
    );
  }
  if (res.status >= 400) {
    let txt = "";
    try { txt = await res.text(); } catch { /* */ }
    throw new OAuthError(
      "introspect_4xx",
      `introspect endpoint returned ${res.status}: ${txt.slice(0, 200)}`,
      { status: res.status },
    );
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw) as IntrospectResponse;
  } catch (err) {
    throw new OAuthError(
      "introspect_malformed",
      `introspect endpoint returned non-JSON: ${raw.slice(0, 200)}`,
      { cause: err },
    );
  }
}

/** Extract Bearer / opaque session token from the Authorization header. */
function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  // Accept both "Bearer X" and bare "X" (opaque session token) — the
  // xiaozhi firmware sends "Bearer <token>"; some test harnesses send
  // the raw token. Match both, prefer Bearer stripping.
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (match) return match[1];
  const trimmed = auth.trim();
  if (trimmed.length > 0) return trimmed;
  return null;
}
