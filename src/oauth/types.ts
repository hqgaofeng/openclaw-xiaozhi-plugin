/**
 * src/oauth/types.ts — v0.4.0-rc4 (batch 4) — OAuth client shared types.
 *
 * Kept dependency-free so any consumer (client, store, middleware) can
 * import the type vocabulary without dragging in fetch / node:http.
 *
 * ## Spec references
 *
 * - RFC 6749 §4.4 (client_credentials grant) — used for service-to-service
 *   device attestation; no user interaction.
 * - RFC 6749 §6 (refresh_token grant) — used when the AS issues a
 *   refresh_token alongside the access_token.
 * - RFC 7662 (token introspection) — used by the middleware to validate
 *   an opaque Bearer token from the esp32 device.
 *
 * The client is "OAuth for machines" — there's no user redirect, no
 * authorization code, no PKCE. The plugin registers as a confidential
 * client (owning a client_secret) and uses client_credentials + refresh
 * token rotation.
 */

/** Configuration for an OAuth client. */
export interface OAuthConfig {
  /** Client id (assigned by AS at registration). */
  clientId: string;
  /** Client secret (kept in cfg / env, never logged). */
  clientSecret: string;
  /** Token endpoint (POST RFC 6749 §3.2). */
  tokenUrl: string;
  /**
   * Optional introspect endpoint (POST RFC 7662). When omitted,
   * withToken() only refreshes on 401; it cannot actively verify a
   * token before use.
   */
  introspectUrl?: string;
  /** Scope string to request (space-separated, per RFC 6749 §3.3). */
  scope: string;
  /**
   * Optional audience hint passed to the AS via custom param
   * `audience`. Most AS implementations accept this.
   */
  audience?: string;
  /**
   * Clock skew buffer subtracted from expires_in. The access token
   * is considered "needs refresh" when (now >= expiresAt - skewMs).
   * Default 30s.
   */
  skewMs?: number;
}

/** RFC 6749 §5.1 success response (we only model the fields we use). */
export interface TokenResponse {
  access_token: string;
  /** Seconds until expiry. */
  expires_in: number;
  /** Opaque refresh token; may be omitted by client_credentials grant. */
  refresh_token?: string;
  /** Space-separated scopes actually granted. */
  scope?: string;
  /** RFC 6749 §7.1 extension; some AS include it instead of expires_in. */
  expires_at?: number;
  /** Token type, almost always "Bearer". */
  token_type?: string;
}

/** RFC 7662 §2.2 introspect response. */
export interface IntrospectResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  sub?: string;
  /** Device id (xiaozhi-specific extension; AS may not set this). */
  device_id?: string;
  exp?: number;
  iat?: number;
  /** Token type (Bearer, etc.). */
  token_type?: string;
  /** Error description when active=false and the AS includes one. */
  error_description?: string;
}

/** Error class for OAuth failures. Used uniformly across client/middleware. */
export class OAuthError extends Error {
  readonly code: string;
  readonly status?: number;
  override readonly cause?: unknown;
  constructor(
    code: string,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = options?.status;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, OAuthError.prototype);
  }
}

/** Shape stored in the in-memory TokenStore. */
export interface StoredToken {
  token: string;
  /** Epoch ms when this access token expires (with skew already subtracted). */
  expiresAt: number;
  /** Refresh token, if the AS issued one. */
  refreshToken?: string;
  /** Scopes granted with this token (space-separated). */
  scope?: string;
  /** When this row was originally obtained (for diagnostics). */
  fetchedAt: number;
}

/**
 * Minimal subset of the Fetch API the OAuth client needs. Lets tests
 * inject a mock fetch with full control over URL, headers, body, and
 * response sequencing (401 → refresh → retry).
 */
export type FetchImpl = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;
