/**
 * test-oauth-middleware.test.ts — v0.4.0-rc4 (batch 4) — OAuth middleware tests.
 *
 * Coverage:
 *   1. Feature flag OFF → throws (forces caller to use V2 #6.1 path)
 *   2. Feature flag ON + valid token → returns { ok: true, deviceId, scopes }
 *   3. Feature flag ON + missing Authorization header → { ok: false, reason: "no_authorization_header" }
 *   4. Feature flag ON + token introspection returns active=false → { ok: false, reason: "token_inactive" }
 *   5. Feature flag ON + introspect endpoint errors → { ok: false, reason: "introspect_failed" }
 *   6. Feature flag ON + scopes are propagated from introspect response
 *
 * @see src/oauth/middleware.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { oauthMiddleware, setOAuthEnabled } from "../middleware.js";
import { OAuthClient } from "../client.js";
import { TokenStore, resetTokenStoreForTest } from "../store.js";
import type { FetchImpl, IntrospectResponse, OAuthConfig } from "../types.js";
import type { XiaozhiAccount } from "../../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(authHeader: string | null, deviceIdHeader: string | null = "esp32-001"): IncomingMessage {
  return {
    headers: {
      ...(authHeader ? { authorization: authHeader } : {}),
      ...(deviceIdHeader ? { "device-id": deviceIdHeader } : {}),
    },
  } as unknown as IncomingMessage;
}

function mkAccount(overrides: Partial<XiaozhiAccount> = {}): XiaozhiAccount {
  return {
    accountId: "default",
    enabled: true,
    host: "0.0.0.0",
    port: 18789,
    path: "/xiaozhi/v1/",
    tls: { enabled: false, cert: "", key: "" },
    authTokens: {},
    globalAuthToken: "",
    sessionIdPrefix: "xiaozhi",
    ...overrides,
  } as XiaozhiAccount;
}

function makeFetch(introspectResponse: { status: number; body: IntrospectResponse | { error: string } }): { impl: FetchImpl; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const impl: FetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, body: init?.body ?? "" });
    return {
      status: introspectResponse.status,
      statusText: introspectResponse.status === 200 ? "OK" : "Error",
      text: async () => JSON.stringify(introspectResponse.body),
      json: async () => introspectResponse.body,
    };
  });
  return { impl, calls };
}

const baseConfig: OAuthConfig = {
  clientId: "client-1",
  clientSecret: "secret-1",
  tokenUrl: "https://auth.example.com/oauth/token",
  introspectUrl: "https://auth.example.com/oauth/introspect",
  scope: "device.read device.write",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("oauthMiddleware (v0.4.0-rc4 batch 4)", () => {
  beforeEach(() => {
    setOAuthEnabled(false); // default OFF
    resetTokenStoreForTest();
  });

  it("1. feature flag OFF → throws OAuthDisabledError (forces V2 #6.1 path)", async () => {
    setOAuthEnabled(false);
    const req = makeReq("Bearer some-token");
    await expect(
      oauthMiddleware(req, mkAccount()),
    ).rejects.toThrow(/OAuth is not enabled/);
  });

  it("2. feature flag ON + valid token → { ok: true, deviceId, scopes }", async () => {
    setOAuthEnabled(true);
    const { impl } = makeFetch({
      status: 200,
      body: { active: true, device_id: "esp32-001", scope: "device.read device.write" },
    });
    // Build a client manually so we can inject the fetchImpl
    const client = new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} });
    // Inject via the same getter the middleware uses
    // (the middleware uses getOAuthClient() — let's see if we set up the singleton)

    // The middleware will create its own client if none is set; we need
    // to either: (a) build the middleware to accept a client param, or
    // (b) expose a setOAuthClient. The spec says the middleware takes
    // (req, account) only, so we go with (b) — setOAuthClient is the
    // standard test injection point.
    const { setOAuthClient } = await import("../middleware.js");
    setOAuthClient(client);
    const req = makeReq("Bearer opaque-session-token");
    const result = await oauthMiddleware(req, mkAccount());
    expect(result).toEqual({
      ok: true,
      deviceId: "esp32-001",
      scopes: ["device.read", "device.write"],
    });
  });

  it("3. feature flag ON + no Authorization header → { ok: false, reason: 'no_authorization_header' }", async () => {
    setOAuthEnabled(true);
    const { setOAuthClient } = await import("../middleware.js");
    const { impl } = makeFetch({
      status: 200,
      body: { active: true },
    });
    setOAuthClient(new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} }));
    const req = makeReq(null);
    const result = await oauthMiddleware(req, mkAccount());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_authorization_header");
  });

  it("4. feature flag ON + introspect returns active=false → { ok: false, reason: 'token_inactive' }", async () => {
    setOAuthEnabled(true);
    const { setOAuthClient } = await import("../middleware.js");
    const { impl } = makeFetch({
      status: 200,
      body: { active: false, error_description: "token revoked" },
    });
    setOAuthClient(new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} }));
    const req = makeReq("Bearer revoked-token");
    const result = await oauthMiddleware(req, mkAccount());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("token_inactive");
  });

  it("5. feature flag ON + introspect endpoint returns 5xx → { ok: false, reason: 'introspect_failed:introspect_5xx' }", async () => {
    setOAuthEnabled(true);
    const { setOAuthClient } = await import("../middleware.js");
    const { impl } = makeFetch({
      status: 500,
      body: { error: "server_error" },
    });
    setOAuthClient(new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} }));
    const req = makeReq("Bearer some-token");
    const result = await oauthMiddleware(req, mkAccount());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("introspect_failed:introspect_5xx");
  });

  it("6. feature flag ON + scopes are propagated from introspect response (split by space)", async () => {
    setOAuthEnabled(true);
    const { setOAuthClient } = await import("../middleware.js");
    const { impl } = makeFetch({
      status: 200,
      body: { active: true, device_id: "esp32-001", scope: "device.read device.write admin" },
    });
    setOAuthClient(new OAuthClient(baseConfig, { fetchImpl: impl, sleep: async () => {} }));
    const req = makeReq("Bearer valid-token");
    const result = await oauthMiddleware(req, mkAccount());
    expect(result.ok).toBe(true);
    expect(result.scopes).toEqual(["device.read", "device.write", "admin"]);
  });
});
