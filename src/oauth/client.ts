/**
 * src/oauth/client.ts — v0.4.0-rc4 (batch 4) — OAuth client_credentials
 * + refresh_token client.
 *
 * Use case: a service plugin (the xiaozhi gateway) needs to obtain
 * access tokens from a vendor's OAuth Authorization Server. We do NOT
 * implement user-facing authorization code flows — there is no
 * browser, no end-user login. Instead:
 *
 *   - First call: POST client_credentials → get access_token (+ optional
 *     refresh_token). Cached in the in-memory TokenStore.
 *   - Subsequent calls: cached until skew-adjusted expiry.
 *   - Expiry: POST refresh_token grant (or, if no refresh_token,
 *     client_credentials again).
 *   - On 401 from the protected API: invalidate cache, refresh, retry
 *     the API call exactly once.
 *
 * No external SDK — the only dependency is `fetch` (Node 18+ built-in,
 * or injected via fetchImpl in tests). Token storage is in-memory
 * (see TokenStore); process restart requires a new grant.
 *
 * @see src/oauth/store.ts
 * @see src/oauth/types.ts
 * @see src/oauth/middleware.ts
 */

import {
  OAuthError,
  type FetchImpl,
  type OAuthConfig,
  type TokenResponse,
  type StoredToken,
} from "./types.js";
import { withBackoff, isNetworkError, is5xxError, type SleepFn } from "../retry.js";

// ---------------------------------------------------------------------------
// Client options (caller-tunable, with sensible defaults)
// ---------------------------------------------------------------------------

export interface OAuthClientOptions {
  /** Inject fetch (for tests). Default: globalThis.fetch. */
  fetchImpl?: FetchImpl;
  /** Inject sleep (for tests). Default: real setTimeout. */
  sleep?: SleepFn;
  /**
   * Override Math.random (for tests that want to verify jitter range).
   * Default: Math.random.
   */
  random?: () => number;
  /**
   * Max retry attempts for the token endpoint on 5xx / network errors.
   * Default 3 (1 initial + 2 retries).
   */
  maxAttempts?: number;
  /** Backoff base ms for token endpoint retries. Default 100. */
  baseMs?: number;
}

// ---------------------------------------------------------------------------
// OAuthClient
// ---------------------------------------------------------------------------

/**
 * Stateful OAuth client. Holds the cached token in-memory for the
 * lifetime of the process. The fetchImpl + sleep are injected so
 * tests don't hit the network and don't actually wait between retries.
 */
export class OAuthClient {
  private readonly cfg: Required<Pick<OAuthConfig, "clientId" | "clientSecret" | "tokenUrl" | "scope">> & OAuthConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: SleepFn;
  private readonly maxAttempts: number;
  private readonly baseMs: number;
  private readonly random: () => number;
  private readonly skewMs: number;
  /** Cached token; null when invalidated. */
  private cached: StoredToken | null = null;

  constructor(config: OAuthConfig, opts: OAuthClientOptions = {}) {
    this.cfg = { ...config };
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl | undefined) ?? nullFallbackFetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseMs = opts.baseMs ?? 100;
    this.random = opts.random ?? Math.random;
    this.skewMs = config.skewMs ?? 30_000;
  }

  /**
   * Invalidate the cached token. The next getAccessToken() will refresh
   * (using the stored refresh_token if available, otherwise re-grant
   * client_credentials). We keep the cached entry around with
   * `expiresAt = 0` so the refresh path can still see the refresh_token.
   * Public so the middleware can call it when the introspect endpoint
   * tells us the token is no longer active.
   */
  invalidate(): void {
    if (this.cached) {
      this.cached = { ...this.cached, expiresAt: 0 };
    } else {
      this.cached = null;
    }
  }

  /**
   * Return a non-expired access token, fetching a new one if needed.
   * Multiple callers in the same process get the same in-memory token
   * (no per-call HTTP). When the cached token is within skewMs of
   * expiry, we proactively refresh.
   */
  async getAccessToken(): Promise<{ token: string; expiresAt: number }> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return { token: this.cached.token, expiresAt: this.cached.expiresAt };
    }
    // Cached token expired, missing, or invalidated. Refresh.
    // We may have a refresh_token in the cache (preserve across invalidate())
    // — prefer it over re-running client_credentials.
    const stored = this.cached?.refreshToken
      ? await this.refreshWithToken(this.cached.refreshToken)
      : await this.grantClientCredentials();
    this.cached = stored;
    return { token: stored.token, expiresAt: stored.expiresAt };
  }

  /**
   * Run `fn` with a valid access token. If the API call returns a 401
   * (detected by message "HTTP 401" or the inner fn throwing an
   * `OAuthError` with status=401), invalidate the cache, refresh,
   * and retry ONCE. Other errors propagate as-is.
   *
   * Note: this is "single retry on 401" because an OAuth client
   * should never get into a refresh loop — if the new token also
   * 401s, the credentials are wrong and we should surface that.
   */
  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    let token: string;
    try {
      const r = await this.getAccessToken();
      token = r.token;
    } catch (err) {
      // getAccessToken itself failed; nothing to do but propagate.
      throw err;
    }
    try {
      return await fn(token);
    } catch (err) {
      if (!isUnauthorized(err)) throw err;
      // 401 — refresh and retry exactly once. If the retry also
      // returns 401, the credentials are wrong; surface as OAuthError
      // (don't loop, don't keep refreshing forever).
      this.invalidate();
      let r2;
      try {
        r2 = await this.getAccessToken();
      } catch (refreshErr) {
        throw new OAuthError(
          "refresh_failed",
          "OAuth refresh after 401 also failed: " +
            String((refreshErr as Error)?.message ?? refreshErr),
          { cause: refreshErr },
        );
      }
      try {
        return await fn(r2.token);
      } catch (retryErr) {
        if (isUnauthorized(retryErr)) {
          throw new OAuthError(
            "auth_invalid",
            "OAuth token rejected twice (refreshed token still 401): credentials invalid",
            { status: 401, cause: retryErr },
          );
        }
        throw retryErr;
      }
    }
  }

  /**
   * POST refresh_token grant.
   */
  private async refreshWithToken(refreshToken: string): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    if (this.cfg.scope) body.set("scope", this.cfg.scope);
    return this.fetchAndStore(body.toString());
  }

  /**
   * POST client_credentials grant.
   */
  private async grantClientCredentials(): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: this.cfg.scope,
    });
    if (this.cfg.audience) body.set("audience", this.cfg.audience);
    return this.fetchAndStore(body.toString());
  }

  /**
   * POST to the token endpoint with retry on 5xx / network errors.
   * The function returns the stored token (or throws).
   */
  private async fetchAndStore(body: string): Promise<StoredToken> {
    const fetchOnce = async (): Promise<StoredToken> => {
      const res = await this.fetchImpl(this.cfg.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      });
      // 5xx + network: retried via withBackoff
      if (res.status >= 500) {
        let txt = "";
        try { txt = await res.text(); } catch { /* */ }
        throw new OAuthError(
          "token_endpoint_5xx",
          `OAuth token endpoint returned ${res.status}: ${txt.slice(0, 200)}`,
          { status: res.status },
        );
      }
      // 4xx (other than 401) — not retried. Surface as OAuthError.
      if (res.status >= 400) {
        let txt = "";
        try { txt = await res.text(); } catch { /* */ }
        let parsed: Record<string, unknown> = {};
        try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* */ }
        throw new OAuthError(
          "token_endpoint_4xx",
          `OAuth token endpoint returned ${res.status}: ` +
            (String(parsed.error_description ?? txt) || res.statusText).slice(0, 200),
          { status: res.status },
        );
      }
      // 2xx — parse and validate.
      const raw = await res.text();
      let parsed: TokenResponse;
      try {
        parsed = JSON.parse(raw) as TokenResponse;
      } catch (err) {
        throw new OAuthError(
          "malformed_token_response",
          `OAuth token endpoint returned non-JSON body: ${raw.slice(0, 200)}`,
          { cause: err },
        );
      }
      if (!parsed.access_token) {
        throw new OAuthError(
          "malformed_token_response",
          `OAuth token response missing access_token: ${raw.slice(0, 200)}`,
        );
      }
      return this.toStoredToken(parsed);
    };
    // Wrap with backoff for 5xx + network errors. 4xx is non-retryable.
    // We catch RetryExhaustedError and re-throw as OAuthError so the
    // public surface is uniform (callers don't need to know we use
    // withBackoff under the hood).
    try {
      return await withBackoff(fetchOnce, {
        attempts: this.maxAttempts,
        baseMs: this.baseMs,
        maxMs: 5000,
        jitter: 0.2,
        sleep: this.sleep,
        random: this.random,
        retryOn: (err) =>
          isNetworkError(err) ||
          is5xxError(err) ||
          (err instanceof OAuthError && err.code === "token_endpoint_5xx"),
      });
    } catch (err) {
      if (err instanceof OAuthError) throw err;
      // RetryExhaustedError or other — normalize.
      throw new OAuthError(
        "token_endpoint_unavailable",
        `OAuth token endpoint failed after ${this.maxAttempts} attempts: ` +
          String((err as Error)?.message ?? err),
        { cause: err },
      );
    }
  }

  /**
   * Convert the AS response to our StoredToken shape, computing
   * expiresAt = now + expires_in*1000 - skewMs.
   */
  private toStoredToken(r: TokenResponse): StoredToken {
    // Some AS implementations return absolute `expires_at` (epoch seconds);
    // prefer that when present, otherwise compute from `expires_in`.
    const now = Date.now();
    let expiresAt: number;
    if (typeof r.expires_at === "number" && r.expires_at > 0) {
      // RFC 6749 doesn't define expires_at; we treat it as epoch SECONDS
      // (consistent with exp claim in JWT).
      expiresAt = r.expires_at * 1000 - this.skewMs;
    } else if (typeof r.expires_in === "number" && r.expires_in > 0) {
      expiresAt = now + r.expires_in * 1000 - this.skewMs;
    } else {
      // No expiry info — be safe and force a refresh next call.
      expiresAt = now - 1;
    }
    return {
      token: r.access_token,
      expiresAt,
      refreshToken: r.refresh_token,
      scope: r.scope,
      fetchedAt: now,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True iff the error from the inner API call looks like a 401. */
function isUnauthorized(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof OAuthError && err.status === 401) return true;
  const msg = String((err as { message?: unknown })?.message ?? err);
  if (typeof msg !== "string") return false;
  return /HTTP\s*401|status\s*401|401\s*Unauthorized/i.test(msg);
}

const defaultSleep: SleepFn = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Fallback fetch when globalThis.fetch is missing (older Node, exotic env). */
const nullFallbackFetch: FetchImpl = () => {
  throw new OAuthError(
    "fetch_unavailable",
    "OAuth client requires fetch (Node 18+) or an injected fetchImpl",
  );
};
