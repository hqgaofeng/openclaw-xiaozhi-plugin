/**
 * src/retry.ts — v0.4.0-rc4 (batch 4) — generic exponential-backoff helper.
 *
 * Zero external dependencies. Pure functions, fully testable via
 * `sleep` injection. Designed for opt-in use at 5 known external-API
 * call sites (esp32ListenHandler asr.transcribe, MiniMax HTTP, two
 * sherpa-onnx model loads; the ota.ts device-info parse is sync
 * and out of scope).
 *
 * ## Usage
 *
 *   import { withBackoff, isNetworkError, is5xxError } from "./retry.js";
 *
 *   const res = await withBackoff(() => asr.transcribe(pcm), {
 *     attempts: 3,
 *     baseMs: 100,
 *     retryOn: isNetworkError,
 *   });
 *
 * ## Defaults
 *
 *   attempts: 3        (1 initial + 2 retries)
 *   baseMs:   100      (first retry after ~100ms)
 *   maxMs:    5000     (cap to 5s so a long backoff doesn't block a request)
 *   jitter:   true     (0.2 amplitude — ±20% on each delay)
 *   retryOn:  defaultRetryOn  (network + 5xx; not 4xx, not business errors)
 *
 * ## Testability
 *
 * `sleep` is injectable (defaults to setTimeout-based). Tests pass a
 * no-op `sleep` to keep the suite fast. `retryOn` is injectable so
 * call sites can encode their own retry policy without rewriting
 * backoff math.
 *
 * @see docs/plan-v3-xiaozhi-plugin.md (batch 4 spec, §"retry helper")
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Async sleep, in ms. Injectable for tests (don't want real waits). */
export type SleepFn = (ms: number) => Promise<void>;

export interface BackoffOptions {
  /** Max attempts INCLUDING the first. Default 3. */
  attempts?: number;
  /** Base delay for the first retry. Default 100ms. */
  baseMs?: number;
  /** Cap on each backoff. Default 5000ms. */
  maxMs?: number;
  /**
   * Jitter amplitude as a fraction of the delay. 0 = no jitter,
   * 0.2 = ±20% (default). Set to 0 for deterministic tests.
   */
  jitter?: number | boolean;
  /**
   * Predicate deciding whether to retry on a given error. Default:
   * `defaultRetryOn` (network + 5xx only).
   */
  retryOn?: (err: unknown) => boolean;
  /** Optional observer called before each sleep. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Inject for tests; default is setTimeout-based real sleep. */
  sleep?: SleepFn;
  /** Inject for tests; default is Math.random. */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// RetryExhaustedError
// ---------------------------------------------------------------------------

/**
 * Thrown by `withBackoff` when all attempts failed. `.cause` is the
 * last error thrown by the wrapped function. This is the only
 * error class the helper ever throws — everything else is just
 * `err instanceof Error` and gets re-wrapped at exhaustion.
 */
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  override readonly cause?: unknown;
  constructor(attempts: number, lastError: unknown, message?: string) {
    super(
      message ?? `withBackoff: retry failed after ${attempts} attempts`,
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.cause = lastError;
    // Restore prototype chain for instanceof to work across realms
    Object.setPrototypeOf(this, RetryExhaustedError.prototype);
  }
}

// ---------------------------------------------------------------------------
// withBackoff — the main helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` with exponential backoff. Retries up to `attempts - 1`
 * times when `retryOn(err)` returns true. Between retries, sleeps
 * `min(baseMs * 2^(attempt-1), maxMs) * (1 ± jitter)`.
 *
 * Successful results pass through. All attempts failing throws
 * RetryExhaustedError.
 *
 * @param fn  async function to invoke
 * @param opts  backoff tuning (see BackoffOptions)
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = Math.max(0, opts.baseMs ?? 100);
  const maxMs = Math.max(baseMs, opts.maxMs ?? 5000);
  const jitterAmp = opts.jitter === false
    ? 0
    : typeof opts.jitter === "number"
      ? Math.max(0, Math.min(1, opts.jitter))
      : 0.2;
  const retryOn = opts.retryOn ?? defaultRetryOn;
  const onRetry = opts.onRetry;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) {
        break;
      }
      if (!retryOn(err)) {
        // Caller said "don't retry" — surface the original error, not
        // RetryExhaustedError. The caller probably has special handling
        // (e.g. 4xx should bubble up as 401/403 to the user).
        throw err;
      }
      const delay = computeBackoffMs(attempt, baseMs, maxMs, jitterAmp, random);
      if (onRetry) onRetry(attempt, err, delay);
      await sleep(delay);
    }
  }
  throw new RetryExhaustedError(attempts, lastError);
}

/**
 * Compute the backoff delay for a given attempt number (1-indexed).
 * attempt=1 → baseMs, attempt=2 → baseMs*2, attempt=3 → baseMs*4, …
 * capped at maxMs, optionally jittered by `jitterAmp` (0..1).
 */
function computeBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterAmp: number,
  random: () => number,
): number {
  // attempt-1 because the delay BEFORE attempt N corresponds to N-1
  // prior failures. baseMs * 2^(0) = baseMs for first retry.
  const exp = Math.min(attempt - 1, 30); // 2^30 is the safe int cap
  const raw = baseMs * 2 ** exp;
  const capped = Math.min(raw, maxMs);
  if (jitterAmp <= 0) return Math.floor(capped);
  // Symmetric jitter: ±(jitterAmp * capped)
  const jitter = (random() * 2 - 1) * jitterAmp * capped;
  return Math.max(0, Math.floor(capped + jitter));
}

// ---------------------------------------------------------------------------
// Default sleep — setTimeout-based. Tests inject their own.
// ---------------------------------------------------------------------------

const defaultSleep: SleepFn = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Error classifiers — exported so call sites can reuse them
// ---------------------------------------------------------------------------

/**
 * Heuristic for "is this a network failure (connect/timeout/DNS/reset)".
 * We don't strictly need a real error.code, so this works for the
 * `Error: connect ECONNREFUSED …` strings Node throws, and for the
 * `TypeError: fetch failed` that the Fetch API raises on DNS / connect
 * errors. The string scan is intentionally loose; if you need exact
 * Node error code matching, use `retryOn` with your own predicate.
 */
export function isNetworkError(err: unknown): boolean {
  if (err == null) return false;
  // TypeError "fetch failed" is the Fetch API's catch-all for
  // network-layer failures (DNS, connect, TLS, reset). Treat as retry.
  if (err instanceof TypeError) {
    return /fetch failed|network|load failed/i.test(String((err as Error).message));
  }
  if (typeof err !== "object") return false;
  const msg = String((err as { message?: unknown }).message ?? "");
  if (typeof msg !== "string" || msg.length === 0) return false;
  return /ECONN|ETIMEDOUT|ENOTFOUND|ECONNRESET|EPIPE|EAI_AGAIN|socket hang up|network error|fetch failed/i.test(
    msg,
  );
}

/**
 * Heuristic for "is this a 5xx HTTP status". Scans the error message
 * for a `5xx` token; we don't unwrap the response because the helper
 * is just a predicate for `retryOn`. If you have the actual Response
 * object, just use `retryOn: (e) => e instanceof Response && e.status >= 500`.
 */
export function is5xxError(err: unknown): boolean {
  if (err == null) return false;
  const msg = String((err as { message?: unknown }).message ?? err);
  if (typeof msg !== "string" || msg.length === 0) return false;
  return /HTTP\s*5\d\d|status\s*5\d\d|5\d\d\s+(server|service|gateway|bad gateway|timeout)/i.test(
    msg,
  );
}

/**
 * Default retry predicate: retry on network errors and 5xx; do not
 * retry on 4xx, business errors, or anything that doesn't match.
 */
export function defaultRetryOn(err: unknown): boolean {
  return isNetworkError(err) || is5xxError(err);
}
