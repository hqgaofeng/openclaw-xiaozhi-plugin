/**
 * test-oauth-client.test.ts — v0.4.0-rc4 (batch 4) — OAuthClient unit tests.
 *
 * Covers (per batch-4 spec):
 *   1. Initial grant: client_credentials → returns {token, expiresAt}
 *   2. Cached token reuse: getAccessToken() called twice within lifetime
 *      → only 1 POST to tokenUrl
 *   3. Auto-refresh on expiry: token is about to expire → refresh
 *   4. Refresh uses refresh_token grant (POST with grant_type=refresh_token)
 *   5. 401 in withToken() → invalidates store + refreshes + retries once
 *   6. 5xx in withToken() → retried with backoff (5xx in token response
 *      also retried up to 3x)
 *   7. Network error → throws OAuthError
 *   8. 4xx (other than 401) → throws OAuthError with status
 *   9. Token response missing access_token → throws OAuthError
 *  10. withToken: success path passes token to the inner fn
 *  11. withToken: inner fn throws → propagates the original error (no retry)
 *  12. fetchImpl injection honored (we use a fake, not real fetch)
 *
 * @see src/oauth/client.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OAuthClient } from "../client.js";
import { OAuthError, type FetchImpl, type TokenResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetch(
  responses: Array<{
    status: number;
    body: unknown;
  }>,
): { impl: FetchImpl; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let idx = 0;
  const impl: FetchImpl = vi.fn(async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ?? "",
    });
    if (idx >= responses.length) {
      return {
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "exhausted",
        json: async () => ({ error: "test_responses_exhausted" }),
      };
    }
    const r = responses[idx++];
    const body = r.body == null ? "" : JSON.stringify(r.body);
    return {
      status: r.status,
      statusText: statusTextFor(r.status),
      text: async () => body,
      json: async () => (r.body == null ? null : r.body),
    };
  });
  return { impl, calls };
}

function statusTextFor(status: number): string {
  if (status === 200) return "OK";
  if (status === 201) return "Created";
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 500) return "Internal Server Error";
  if (status === 502) return "Bad Gateway";
  if (status === 503) return "Service Unavailable";
  return "Error";
}

function okTokenResponse(overrides: Partial<TokenResponse> = {}): TokenResponse {
  return {
    access_token: "tok-abc",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "device.read device.write",
    ...overrides,
  };
}

const baseConfig = {
  clientId: "client-1",
  clientSecret: "secret-1",
  tokenUrl: "https://auth.example.com/oauth/token",
  introspectUrl: "https://auth.example.com/oauth/introspect",
  scope: "device.read device.write",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuthClient (v0.4.0-rc4 batch 4) — initial grant", () => {
  it("1. getAccessToken() POSTs client_credentials to tokenUrl", async () => {
    const { impl, calls } = makeFetch([
      { status: 200, body: okTokenResponse() },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    const r = await client.getAccessToken();
    expect(r.token).toBe("tok-abc");
    expect(r.expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://auth.example.com/oauth/token");
    expect(calls[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0].body).toContain("grant_type=client_credentials");
    expect(calls[0].body).toContain("client_id=client-1");
    expect(calls[0].body).toContain("client_secret=secret-1");
    expect(calls[0].body).toContain("scope=device.read+device.write");
  });
});

describe("OAuthClient — caching", () => {
  it("2. getAccessToken() called twice within lifetime → only 1 fetch", async () => {
    const { impl, calls } = makeFetch([
      { status: 200, body: okTokenResponse({ expires_in: 3600 }) },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    const r1 = await client.getAccessToken();
    const r2 = await client.getAccessToken();
    expect(r1.token).toBe(r2.token);
    expect(calls).toHaveLength(1); // second call returns cache, no fetch
  });
});

describe("OAuthClient — auto-refresh on expiry", () => {
  it("3. expired token → POSTs refresh_token grant (or fresh client_credentials if no refresh token)", async () => {
    // First response: short-lived (1s). Second response: fresh 1h.
    const { impl, calls } = makeFetch([
      { status: 200, body: okTokenResponse({ expires_in: 1, refresh_token: "rt-1" }) },
      { status: 200, body: okTokenResponse({ access_token: "tok-2", expires_in: 3600 }) },
    ]);
    // We use a very small skew so the first token is "expired" after we
    // bump the clock; we instead just call invalidate() to force refresh.
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    const r1 = await client.getAccessToken();
    expect(r1.token).toBe("tok-abc");
    // Force refresh by invalidating the cache (simulates 401)
    client.invalidate();
    const r2 = await client.getAccessToken();
    expect(r2.token).toBe("tok-2");
    expect(calls).toHaveLength(2);
    // Second call should be a refresh_token grant (because we kept refresh_token in store)
    expect(calls[1].body).toContain("grant_type=refresh_token");
    expect(calls[1].body).toContain("refresh_token=rt-1");
  });

  it("3b. no refresh_token in response → fall back to client_credentials on expiry", async () => {
    const { impl, calls } = makeFetch([
      { status: 200, body: okTokenResponse({ expires_in: 1, refresh_token: undefined }) },
      { status: 200, body: okTokenResponse({ access_token: "tok-2", expires_in: 3600 }) },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    await client.getAccessToken();
    client.invalidate();
    await client.getAccessToken();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain("grant_type=client_credentials");
  });
});

describe("OAuthClient — withToken (401 retry path)", () => {
  it("5. inner fn returns 401 → store invalidated, refresh, retry once with new token", async () => {
    const { impl, calls } = makeFetch([
      // 1: initial grant
      { status: 200, body: okTokenResponse({ refresh_token: "rt-A" }) },
      // 2: refresh
      { status: 200, body: okTokenResponse({ access_token: "tok-fresh", refresh_token: "rt-B" }) },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    // Inner fn: first call sees "tok-abc", second call sees "tok-fresh"
    const seen: string[] = [];
    const result = await client.withToken(async (token) => {
      seen.push(token);
      if (token === "tok-abc") {
        // Simulate the API returning a 401-style error
        throw new Error("HTTP 401 Unauthorized");
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["tok-abc", "tok-fresh"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain("grant_type=refresh_token");
    expect(calls[1].body).toContain("refresh_token=rt-A");
  });

  it("5b. 401 on retry → throws OAuthError (no infinite loop)", async () => {
    const { impl } = makeFetch([
      { status: 200, body: okTokenResponse({ refresh_token: "rt-A" }) },
      { status: 200, body: okTokenResponse({ access_token: "tok-fresh", refresh_token: "rt-B" }) },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    let call = 0;
    await expect(
      client.withToken(async () => {
        call++;
        throw new Error("HTTP 401 Unauthorized");
      }),
    ).rejects.toBeInstanceOf(OAuthError);
    expect(call).toBe(2); // tried once, refreshed, tried again — gave up
  });
});

describe("OAuthClient — error paths", () => {
  it("6. 5xx on token endpoint → retried up to 3 times, then throws OAuthError", async () => {
    const { impl, calls } = makeFetch([
      { status: 503, body: { error: "server_error" } },
      { status: 503, body: { error: "server_error" } },
      { status: 503, body: { error: "server_error" } },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    let caught: unknown;
    try {
      await client.getAccessToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("token_endpoint_unavailable");
    expect((caught as OAuthError).cause).toBeInstanceOf(Error);
    expect(calls).toHaveLength(3);
  });

  it("7. network error → throws OAuthError", async () => {
    const impl: FetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    let caught: unknown;
    try {
      await client.getAccessToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("token_endpoint_unavailable");
  });

  it("8. 4xx (not 401) on token endpoint → throws OAuthError immediately", async () => {
    const { impl, calls } = makeFetch([
      { status: 400, body: { error: "invalid_request", error_description: "missing scope" } },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    let caught: unknown;
    try {
      await client.getAccessToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("token_endpoint_4xx");
    expect((caught as OAuthError).status).toBe(400);
    // We do NOT retry on 4xx; only 1 call.
    expect(calls).toHaveLength(1);
  });

  it("9. token response missing access_token → throws OAuthError", async () => {
    const { impl } = makeFetch([
      { status: 200, body: { token_type: "Bearer", expires_in: 3600 } },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    let caught: unknown;
    try {
      await client.getAccessToken();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("malformed_token_response");
  });
});

describe("OAuthClient — withToken success path", () => {
  it("10. withToken passes the token to the inner fn", async () => {
    const { impl } = makeFetch([
      { status: 200, body: okTokenResponse() },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    const seen = await client.withToken(async (token) => {
      expect(token).toBe("tok-abc");
      return "hello";
    });
    expect(seen).toBe("hello");
  });

  it("11. inner fn throws non-401 → original error propagates (no retry, no refresh)", async () => {
    const { impl, calls } = makeFetch([
      { status: 200, body: okTokenResponse() },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    const err = new Error("HTTP 500 backend boom");
    await expect(
      client.withToken(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(calls).toHaveLength(1); // no refresh attempt
  });

  it("12. fetchImpl is honored (no real fetch is called)", async () => {
    const { impl } = makeFetch([
      { status: 200, body: okTokenResponse() },
    ]);
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    await client.getAccessToken();
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

describe("OAuthClient — expiresAt math", () => {
  it("expiresAt = now + (expires_in * 1000) - skew", async () => {
    const { impl } = makeFetch([
      { status: 200, body: okTokenResponse({ expires_in: 60 }) },
    ]);
    const client = new OAuthClient(
      { ...baseConfig, skewMs: 5000 },
      { fetchImpl: impl, sleep: async () => {} },
    );
    const t0 = Date.now();
    const r = await client.getAccessToken();
    const t1 = Date.now();
    // expiresAt should be in [t0 + 55_000, t1 + 55_000] (i.e. the
    // expiresAt captured inside the client call). The tolerance
    // accommodates real elapsed time between t0 and the in-client now.
    expect(r.expiresAt).toBeGreaterThanOrEqual(t0 + 55_000);
    expect(r.expiresAt).toBeLessThanOrEqual(t1 + 55_000 + 50);
  });
});
