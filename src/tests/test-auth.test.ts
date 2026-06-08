/**
 * test-auth.test.ts — V2 #6.1 / V2 #6.2 auth opt-in
 *
 * 8 scenarios verified against the actual checkAuth implementation:
 *   1. No auth configured (authTokens={} + globalAuthToken="")
 *      → allow everything (V2 #5 compatibility)
 *   2. Global token set, esp32 sends correct token → allow
 *   3. Global token set, esp32 sends wrong token → reject
 *   4. Per-device token set, esp32 sends it → allow
 *   5. Per-device token set, esp32 sends wrong token → reject
 *   6. Global + per-device both set, per-device correct → allow
 *   7. Global + per-device both set, global token sent for SAME device → allow
 *      (V2 #6.1: per-device is checked first; if not match, global
 *       fallback is tried, regardless of deviceId presence)
 *   8. Global + per-device both set, OTHER device with global → allow
 *      (other device has no per-device, falls back to global)
 *   9. Auth enabled but no Authorization header → reject
 *
 * @see src/gateway.ts checkAuth
 */

import { describe, it, expect } from "vitest";
import { checkAuth } from "../gateway.js";
import type { XiaozhiAccount } from "../config.js";

function mkAccount(overrides: Partial<XiaozhiAccount> = {}): XiaozhiAccount {
  return {
    enabled: true,
    host: "0.0.0.0",
    port: 18790,
    path: "/xiaozhi/v1/",
    tls: { enabled: false, cert: "", key: "" },
    authTokens: {},
    globalAuthToken: "",
    sessionIdPrefix: "xiaozhi",
    accountId: "default",
    asr: { provider: "sherpa_onnx", options: {} },
    tts: { provider: "minimax", options: {} },
    ...overrides,
  } as XiaozhiAccount;
}

describe("checkAuth (V2 #6.1 auth opt-in)", () => {
  it("1. no auth configured → allow everything (V2 #5 compat)", () => {
    const acc = mkAccount();
    expect(checkAuth(null, "esp32-001", acc)).toEqual({ ok: true, reason: "" });
    expect(checkAuth("any-token", "esp32-001", acc)).toEqual({
      ok: true,
      reason: "",
    });
  });

  it("2. global token set + correct token → allow", () => {
    const acc = mkAccount({ globalAuthToken: "tok-global-abc" });
    expect(checkAuth("tok-global-abc", "esp32-001", acc)).toEqual({
      ok: true,
      reason: "",
    });
  });

  it("3. global token set + wrong token → reject", () => {
    const acc = mkAccount({ globalAuthToken: "tok-global-abc" });
    expect(checkAuth("tok-wrong", "esp32-001", acc)).toEqual({
      ok: false,
      reason: "wrong_token",
    });
  });

  it("4. per-device token set + correct token → allow", () => {
    const acc = mkAccount({
      authTokens: { "esp32-001": "tok-per-device-xyz" },
    });
    expect(checkAuth("tok-per-device-xyz", "esp32-001", acc)).toEqual({
      ok: true,
      reason: "",
    });
  });

  it("5. per-device token set + wrong token → reject", () => {
    const acc = mkAccount({
      authTokens: { "esp32-001": "tok-per-device-xyz" },
    });
    expect(checkAuth("tok-wrong", "esp32-001", acc)).toEqual({
      ok: false,
      reason: "wrong_token",
    });
  });

  it("6. global + per-device both set + per-device token for this device → allow", () => {
    const acc = mkAccount({
      globalAuthToken: "tok-global-abc",
      authTokens: { "esp32-001": "tok-per-device-xyz" },
    });
    expect(checkAuth("tok-per-device-xyz", "esp32-001", acc)).toEqual({
      ok: true,
      reason: "",
    });
  });

  it("7. global + per-device both set + global token for same device → allow (fallback)", () => {
    // V2 #6.1 design: per-device is checked first; if no match, global
    // is tried as fallback. So both tokens are accepted for the same device.
    const acc = mkAccount({
      globalAuthToken: "tok-global-abc",
      authTokens: { "esp32-001": "tok-per-device-xyz" },
    });
    expect(checkAuth("tok-global-abc", "esp32-001", acc)).toEqual({
      ok: true,
      reason: "",
    });
  });

  it("8. global + per-device both set + other device with global → allow", () => {
    const acc = mkAccount({
      globalAuthToken: "tok-global-abc",
      authTokens: { "esp32-001": "tok-per-device-xyz" },
    });
    // esp32-002 has no per-device entry → falls back to global.
    expect(checkAuth("tok-global-abc", "esp32-002", acc)).toEqual({
      ok: true,
      reason: "",
    });
    // esp32-002 with wrong token → reject.
    expect(checkAuth("tok-wrong", "esp32-002", acc)).toEqual({
      ok: false,
      reason: "wrong_token",
    });
  });

  it("9. auth enabled + no Authorization header → reject", () => {
    const acc = mkAccount({ globalAuthToken: "tok-global-abc" });
    expect(checkAuth(null, "esp32-001", acc)).toEqual({
      ok: false,
      reason: "no_authorization_header",
    });
  });

  it("10. per-device only + no Authorization header → reject", () => {
    const acc = mkAccount({ authTokens: { "esp32-001": "tok-xyz" } });
    expect(checkAuth(null, "esp32-001", acc)).toEqual({
      ok: false,
      reason: "no_authorization_header",
    });
  });
});
