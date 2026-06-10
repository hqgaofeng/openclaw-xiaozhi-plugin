/**
 * src/oauth/store.ts — v0.4.0-rc4 (batch 4) — in-memory OAuth TokenStore.
 *
 * Holds tokens keyed by clientId. Process-local; the gateway does not
 * persist tokens to disk (no security boundary beyond the OS user).
 *
 * ## Design notes
 *
 * - **Why not a Map directly on OAuthClient?** A separate class lets the
 *   middleware introspect the store (e.g. for diagnostics) without
 *   exposing the OAuth client object. Also makes it easy to swap in a
 *   Redis-backed store later for multi-instance deployments.
 *
 * - **Why not auto-expiry sweep?** We do not need one — getAccessToken()
 *   checks expiry on every call. A Map.delete() on a stale row is a
 *   nice-to-have, not a correctness requirement.
 *
 * - **Concurrency.** JS is single-threaded; no locking needed. If you
 *   ever run this on a worker thread, wrap set/get in a Mutex.
 *
 * @see src/oauth/client.ts (the only writer in this commit)
 * @see src/oauth/middleware.ts (the only consumer outside the client)
 */

import type { StoredToken } from "./types.js";

/**
 * Default clock-skew buffer for the isExpired check. Mirrors the
 * default in OAuthClient.skewMs (30s). The store uses this so the
 * middleware can call isExpired on a token it pulled out of the
 * store and get consistent results with the client.
 */
export const DEFAULT_STORE_SKEW_MS = 30_000;

export class TokenStore {
  private map = new Map<string, StoredToken>();
  private readonly defaultSkewMs: number;

  constructor(opts: { defaultSkewMs?: number } = {}) {
    this.defaultSkewMs = opts.defaultSkewMs ?? DEFAULT_STORE_SKEW_MS;
  }

  /** Read the token entry for a clientId, or undefined if missing. */
  get(clientId: string): StoredToken | undefined {
    return this.map.get(clientId);
  }

  /** Insert / replace a token entry. */
  set(clientId: string, token: StoredToken): void {
    this.map.set(clientId, token);
  }

  /** Remove a single clientId's token. No-op if missing. */
  invalidate(clientId: string): void {
    this.map.delete(clientId);
  }

  /**
   * True if the token's expiresAt is at or before (now - skewMs).
   * The skew lets us say "needs refresh" 30s before the actual
   * expiry so the next call doesn't get a stale token.
   */
  isExpired(token: StoredToken, skewMs?: number): boolean {
    const skew = skewMs ?? this.defaultSkewMs;
    return token.expiresAt - skew <= Date.now();
  }

  /** Diagnostics: list all clientIds currently in the store. */
  list(): string[] {
    return Array.from(this.map.keys());
  }

  /**
   * Test-only: wipe all entries. Production code never calls this
   * (process restart is the real "clear" boundary).
   */
  clear(): void {
    this.map.clear();
  }
}

/**
 * Process-wide singleton. The OAuth client + middleware both use this
 * so that, for a given (clientId), the in-memory token is shared
 * across the whole gateway (not per-call-site).
 */
let _singleton: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!_singleton) _singleton = new TokenStore();
  return _singleton;
}

/** Test-only: reset the singleton so the next getTokenStore() returns fresh. */
export function resetTokenStoreForTest(): void {
  _singleton = null;
}
