/**
 * test-oauth-store.test.ts — v0.4.0-rc4 (batch 4) — TokenStore unit tests.
 *
 * Coverage:
 *   1. set + get roundtrip
 *   2. get on missing key returns undefined
 *   3. invalidate removes the entry
 *   4. isExpired: stored.expiresAt <= now → true
 *   5. isExpired: skewMs buffer — token "looks expired" within skewMs
 *   6. Multiple clientIds are isolated
 *
 * @see src/oauth/store.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TokenStore } from "../store.js";
import type { StoredToken } from "../types.js";

function makeStored(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    token: "tok-1",
    expiresAt: Date.now() + 60_000,
    refreshToken: "rt-1",
    scope: "device.read",
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("TokenStore (v0.4.0-rc4 batch 4)", () => {
  let store: TokenStore;
  beforeEach(() => {
    store = new TokenStore();
  });

  it("1. set + get roundtrip", () => {
    const t = makeStored();
    store.set("client-A", t);
    expect(store.get("client-A")).toEqual(t);
  });

  it("2. get on missing key returns undefined", () => {
    expect(store.get("missing")).toBeUndefined();
  });

  it("3. invalidate removes the entry", () => {
    store.set("client-A", makeStored());
    expect(store.get("client-A")).toBeDefined();
    store.invalidate("client-A");
    expect(store.get("client-A")).toBeUndefined();
  });

  it("3b. invalidate on missing key is a no-op (does not throw)", () => {
    expect(() => store.invalidate("missing")).not.toThrow();
  });

  it("4. isExpired: stored.expiresAt <= now → true", () => {
    const past = makeStored({ expiresAt: Date.now() - 1 });
    expect(store.isExpired(past)).toBe(true);
  });

  it("5. isExpired: skewMs buffer — token 'looks expired' within skewMs", () => {
    // 10s in the future, default skew 30s → expired (within skew)
    const almostFuture = makeStored({ expiresAt: Date.now() + 10_000 });
    expect(store.isExpired(almostFuture)).toBe(true);
    // 60s in the future, default skew 30s → not expired
    const future = makeStored({ expiresAt: Date.now() + 60_000 });
    expect(store.isExpired(future)).toBe(false);
    // Custom skewMs
    expect(store.isExpired(almostFuture, 5000)).toBe(false);
  });

  it("6. multiple clientIds are isolated", () => {
    store.set("client-A", makeStored({ token: "tok-A" }));
    store.set("client-B", makeStored({ token: "tok-B" }));
    expect(store.get("client-A")?.token).toBe("tok-A");
    expect(store.get("client-B")?.token).toBe("tok-B");
    store.invalidate("client-A");
    expect(store.get("client-A")).toBeUndefined();
    expect(store.get("client-B")?.token).toBe("tok-B");
  });

  it("7. list() returns all stored clientIds (diagnostics)", () => {
    store.set("client-A", makeStored());
    store.set("client-B", makeStored());
    expect(store.list().sort()).toEqual(["client-A", "client-B"]);
  });

  it("8. clear() wipes everything (test hook)", () => {
    store.set("client-A", makeStored());
    store.set("client-B", makeStored());
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
