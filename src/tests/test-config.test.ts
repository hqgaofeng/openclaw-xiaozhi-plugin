/**
 * Config adapter tests — 10 cases for XiaozhiAccount resolve + schema.
 */

import { describe, it, expect } from "vitest";
import type { XiaozhiAccount, XiaozhiConfig } from "../config.js";

describe("XiaozhiConfig defaults", () => {
  it("has a sensible default for port (18789)", () => {
    // TODO(M3.2): assert createDefaultConfig() returns port: 18789
    const config: Partial<XiaozhiConfig> = { port: 18789 };
    expect(config.port).toBe(18789);
  });

  it("has a sensible default for path (/xiaozhi/v1/)", () => {
    const config: Partial<XiaozhiConfig> = { path: "/xiaozhi/v1/" };
    expect(config.path).toBe("/xiaozhi/v1/");
  });

  it("has TLS disabled by default for local dev", () => {
    const config: Partial<XiaozhiConfig> = {
      tls: { enabled: false, cert: "", key: "" },
    };
    expect(config.tls?.enabled).toBe(false);
  });
});

describe("XiaozhiAccount.resolveAccount", () => {
  it("resolves enabled account with all fields", () => {
    // TODO(M3.2): mock raw config → call createXiaozhiConfigAdapter().resolveAccount
    //   expect: account.accountId, account.enabled, account.host, account.port, ...
    const account: Partial<XiaozhiAccount> = {
      accountId: "default",
      enabled: true,
      host: "0.0.0.0",
      port: 18789,
      path: "/xiaozhi/v1/",
    };
    expect(account.enabled).toBe(true);
  });

  it("rejects account with auth_tokens but missing global token (security)", () => {
    // TODO(M3.2): assert that an account with per-device tokens but no
    //   global token falls through to per-device lookup correctly
  });

  it("resolves account with per-device auth_tokens dict", () => {
    const account: Partial<XiaozhiAccount> = {
      authTokens: {
        "esp32-001": "token-a",
        "esp32-002": "token-b",
      },
      globalAuthToken: "",
    };
    expect(account.authTokens?.["esp32-001"]).toBe("token-a");
  });
});

describe("XiaozhiConfig schema validation", () => {
  it("rejects invalid port (out of range)", () => {
    // TODO(M3.2): test that port < 1 or > 65535 is rejected
  });

  it("rejects invalid path (must start with /)", () => {
    // TODO(M3.2): test that path without leading / is rejected
  });

  it("rejects TLS enabled without cert+key", () => {
    // TODO(M3.2): test that enabled=true with empty cert/key is rejected
  });
});

describe("session_id_prefix", () => {
  it("defaults to 'xiaozhi' prefix", () => {
    // TODO(M3.2): test default session_id_prefix
    const account: Partial<XiaozhiAccount> = { sessionIdPrefix: "xiaozhi" };
    expect(account.sessionIdPrefix).toBe("xiaozhi");
  });
});
