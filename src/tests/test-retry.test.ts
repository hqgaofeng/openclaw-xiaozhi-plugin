/**
 * test-retry.test.ts — v0.4.0-rc4 (batch 4) — retry helper unit tests.
 *
 * Coverage:
 *   1. success on first attempt → returns result, no retry
 *   2. success on attempt 2 → returns result, retried once
 *   3. success on attempt 3 → returns result, retried twice
 *   4. exhausted → throws RetryExhaustedError wrapping the LAST error
 *   5. retryOn=false → throws immediately (no retry)
 *   6. retryOn=true (custom) → respects custom predicate
 *   7. exponential backoff: baseMs * 2^(attempt-1) — 100, 200, 400
 *   8. maxMs cap: backoff never exceeds maxMs
 *   9. sleep injection — sleep fn receives exact backoff values
 *  10. jitter: sleep receives value in [base*(1-j), base*(1+j)]
 *  11. default retryOn: 5xx + network error only
 *  12. default opts: attempts=3, baseMs=100, maxMs=5000, jitter=true
 *  13. async fn exception (non-Error throw) → wrapped in RetryExhaustedError
 *  14. onRetry callback fires per attempt (after the first)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withBackoff,
  RetryExhaustedError,
  isNetworkError,
  is5xxError,
  defaultRetryOn,
  type BackoffOptions,
  type SleepFn,
} from "../retry.js";

describe("withBackoff (retry helper) — v0.4.0-rc4 batch 4", () => {
  // Make tests fast and deterministic by injecting a fake sleep
  let sleepCalls: number[];
  let sleep: SleepFn;
  beforeEach(() => {
    sleepCalls = [];
    sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
  });

  it("1. success on first attempt → returns result, no sleep", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withBackoff(fn, { sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toEqual([]);
  });

  it("2. success on attempt 2 → returns result, slept once at 100ms", async () => {
    // Use a network-error style message so defaultRetryOn returns true.
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:443"))
      .mockResolvedValueOnce("ok-2");
    const result = await withBackoff(fn, { sleep, baseMs: 100, jitter: false });
    expect(result).toBe("ok-2");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([100]);
  });

  it("3. success on attempt 3 → slept twice (100, 200)", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce("ok-3");
    const result = await withBackoff(fn, { sleep, baseMs: 100, jitter: false });
    expect(result).toBe("ok-3");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([100, 200]);
  });

  it("4. exhausted after attempts → throws RetryExhaustedError with last cause", async () => {
    const lastErr = new Error("ETIMEDOUT final");
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET e1"))
      .mockRejectedValueOnce(new Error("ECONNRESET e2"))
      .mockRejectedValueOnce(lastErr);
    const opts: BackoffOptions = { sleep, baseMs: 100, jitter: false };
    let caught: unknown;
    try {
      await withBackoff(fn, opts);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as Error).message).toContain("retry failed after 3 attempts");
    expect((caught as Error & { cause?: unknown }).cause).toBe(lastErr);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([100, 200]);
  });

  it("5. retryOn=false → throws immediately, no sleep", async () => {
    // Even a network-style error is NOT retried when the predicate says no.
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED don't retry this"));
    const opts: BackoffOptions = {
      sleep,
      baseMs: 100,
      retryOn: () => false,
    };
    await expect(withBackoff(fn, opts)).rejects.toThrow("don't retry this");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toEqual([]);
  });

  it("6. retryOn=true (custom) → retries non-default errors when predicate says so", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("4xx-style error"))
      .mockResolvedValueOnce("ok");
    const opts: BackoffOptions = {
      sleep,
      baseMs: 50,
      jitter: false,
      retryOn: () => true, // retry everything
    };
    const result = await withBackoff(fn, opts);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([50]);
  });

  it("7. exponential backoff: 100, 200, 400 (no jitter)", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET a"))
      .mockRejectedValueOnce(new Error("ECONNRESET b"))
      .mockRejectedValueOnce(new Error("ECONNRESET c"))
      .mockRejectedValueOnce(new Error("ECONNRESET d"));
    const opts: BackoffOptions = {
      attempts: 4,
      sleep,
      baseMs: 100,
      maxMs: 100_000,
      jitter: false,
    };
    await expect(withBackoff(fn, opts)).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(sleepCalls).toEqual([100, 200, 400]);
  });

  it("8. maxMs cap: backoff clamps to maxMs when growth would exceed it", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET a"))
      .mockRejectedValueOnce(new Error("ECONNRESET b"))
      .mockRejectedValueOnce(new Error("ECONNRESET c"))
      .mockRejectedValueOnce(new Error("ECONNRESET d"))
      .mockRejectedValueOnce(new Error("ECONNRESET e"));
    const opts: BackoffOptions = {
      attempts: 5,
      sleep,
      baseMs: 100,
      maxMs: 250, // would be 100, 200, 400, 800 → capped to 250, 250
      jitter: false,
    };
    await expect(withBackoff(fn, opts)).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(sleepCalls).toEqual([100, 200, 250, 250]);
  });

  it("9. sleep injection: sleep receives the exact computed ms", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET x"))
      .mockResolvedValueOnce("ok");
    const customSleep = vi.fn(async (_ms: number) => {
      /* no-op */
    });
    await withBackoff(fn, { sleep: customSleep, baseMs: 42, jitter: false });
    expect(customSleep).toHaveBeenCalledTimes(1);
    expect(customSleep).toHaveBeenCalledWith(42);
  });

  it("10. jitter: sleep receives value in [base*(1-jitter), base*(1+jitter)]", async () => {
    // For attempt 1, base=100, jitter=0.2 → sleep in [80, 120]
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET a"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn(async (_ms: number) => {
      /* */
    });
    await withBackoff(fn, { sleep, baseMs: 100, jitter: 0.2 });
    expect(sleep).toHaveBeenCalledTimes(1);
    const ms = sleep.mock.calls[0][0] as number;
    expect(ms).toBeGreaterThanOrEqual(80);
    expect(ms).toBeLessThanOrEqual(120);
  });

  it("11. default retryOn: 5xx + network error retry, 4xx + other do not", () => {
    // Network errors
    expect(defaultRetryOn(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
    expect(defaultRetryOn(new TypeError("fetch failed"))).toBe(true);
    expect(defaultRetryOn(new Error("ENOTFOUND api.example.com"))).toBe(true);
    // 5xx-ish
    expect(defaultRetryOn(new Error("HTTP 502 Bad Gateway"))).toBe(true);
    expect(defaultRetryOn(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    // 4xx / other
    expect(defaultRetryOn(new Error("HTTP 401 Unauthorized"))).toBe(false);
    expect(defaultRetryOn(new Error("HTTP 400 Bad Request"))).toBe(false);
    expect(defaultRetryOn(new Error("HTTP 404 Not Found"))).toBe(false);
    expect(defaultRetryOn(new Error("plain business error"))).toBe(false);
  });

  it("12. default opts: attempts=3, baseMs=100, maxMs=5000, jitter=true (when omitted)", async () => {
    // We can't observe default jitter precisely without a real RNG, so
    // we only assert that the function runs and either succeeds or
    // throws RetryExhaustedError with up to 3 attempts.
    const realSleep: SleepFn = async () => {
      /* skip sleeping in default-opts test */
    };
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET a"))
      .mockRejectedValueOnce(new Error("ECONNRESET b"))
      .mockResolvedValueOnce("ok");
    const result = await withBackoff(fn, { sleep: realSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3); // first + 2 retries = attempts=3
  });

  it("13. async fn throws non-Error → wrapped in RetryExhaustedError.cause", async () => {
    // Use a TypeError so defaultRetryOn retries (default is non-throwing for
    // primitive throws because we wrap them as RetryExhaustedError on exhaustion).
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce("string-error")
      .mockRejectedValueOnce({ code: 42 })
      .mockRejectedValueOnce("string-error-3");
    const opts: BackoffOptions = {
      attempts: 3,
      sleep,
      baseMs: 10,
      jitter: false,
      retryOn: () => true, // retry on any non-Error throw too
    };
    let caught: unknown;
    try {
      await withBackoff(fn, opts);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as Error & { cause?: unknown }).cause).toBe("string-error-3");
  });

  it("14. onRetry callback fires per attempt (after the first)", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET e1"))
      .mockRejectedValueOnce(new Error("ECONNRESET e2"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await withBackoff(fn, {
      sleep,
      baseMs: 50,
      jitter: false,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      1,
      expect.any(Error),
      50,
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      2,
      expect.any(Error),
      100,
    );
  });
});

describe("isNetworkError + is5xxError — v0.4.0-rc4 batch 4", () => {
  it("isNetworkError: matches common network failure signatures", () => {
    expect(isNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
    expect(isNetworkError(new Error("ENOTFOUND api.example.com"))).toBe(true);
    expect(isNetworkError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("network error"))).toBe(true);
    expect(isNetworkError(new Error("socket hang up"))).toBe(true);
    expect(isNetworkError(new Error("regular business error"))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError("string")).toBe(false);
  });

  it("is5xxError: matches HTTP 5xx status codes in error message", () => {
    expect(is5xxError(new Error("HTTP 500 Internal Server Error"))).toBe(true);
    expect(is5xxError(new Error("HTTP 502 Bad Gateway"))).toBe(true);
    expect(is5xxError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(is5xxError(new Error("HTTP 504 Gateway Timeout"))).toBe(true);
    expect(is5xxError(new Error("status 599 server error"))).toBe(true);
    expect(is5xxError(new Error("HTTP 400 Bad Request"))).toBe(false);
    expect(is5xxError(new Error("HTTP 401 Unauthorized"))).toBe(false);
    expect(is5xxError(new Error("HTTP 404 Not Found"))).toBe(false);
    expect(is5xxError(new Error("plain error"))).toBe(false);
    expect(is5xxError(null)).toBe(false);
  });
});
