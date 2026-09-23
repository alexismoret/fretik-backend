import { isRecord } from "../../external-apps/json-access";

/**
 * Detect whether a thrown error from the Nango Node SDK (`nango.proxy`,
 * `nango.getConnection`, …) signals a durable authentication failure
 * — i.e. the user must reconnect.
 *
 * Sources of the patterns matched here:
 *  - Nango SDK error codes: `@nangohq/types/dist/api.d.ts` (ResDefaultErrors enum)
 *  - OAuth 2.0 RFC 6749 (`invalid_grant`)
 *  - Empirical: revoking a Microsoft Outlook consent yields HTTP 400 +
 *    `code: "server_error"` + message "Failed to get connection
 *    credentials: 'The external API returned an error when trying to
 *    refresh the access token...'". Nango masks the AADSTS code, so we
 *    match the message string instead.
 *
 * What this NEVER matches (kept transient / let the caller retry):
 *  - HTTP 429 (rate limit) — Nango retries with backoff already.
 *  - HTTP 5xx — provider or Nango down, retried by Nango.
 *  - Node network errors (`ECONNRESET`, `ETIMEDOUT`, …).
 *  - `code: "server_error"` without a known message pattern — ambiguous,
 *    could be a real Nango internal bug unrelated to auth.
 */

/** Nango codes that ALWAYS mean "credentials are dead". */
const NANGO_AUTH_FAILURE_CODES = new Set<string>([
  "invalid_credentials", // Nango — refresh limit exhausted
  "invalid_grant", // OAuth 2.0 RFC 6749 — refresh expired/revoked
  "unknown_connection", // Connection deleted on the Nango side
]);

/** Substrings in the error message that signal a durable auth failure. */
const AUTH_FAILURE_MESSAGE_PATTERNS = [
  "failed to get connection credentials", // Nango wrap (observed empirically)
  "refresh the access token", // alternate phrasing in the same wrap
  "invalid_grant", // provider passthrough as plain text
  "invalid_refresh_token", // provider variant
  "token has been expired",
  "token revoked",
  "authorization revoked",
  "insufficient_scope", // OAuth scope removed by tenant admin
];

/**
 * The same signal from a `custom-handler` provider, where the wire is not
 * HTTP and there is no status code to read.
 *
 * `callCustomHandler` has always claimed this worked — "IMAP returns
 * AUTHENTICATIONFAILED, SMTP raises an EAUTH; if `isAuthFailure` matches the
 * thrown error we mark the connection" — but every pattern above is an OAuth
 * or Nango phrasing, so none of those errors ever matched. The consequence is
 * silent and long-lived: a mailbox password rotated by IT, or an SFTP account
 * disabled by a partner, keeps the connection `active` forever. Every call
 * fails, the card shows no problem, and the user is never offered the
 * Reconnect button that exists for exactly this.
 *
 * Each entry is a protocol's own way of saying "these credentials are
 * wrong", and all of them are DURABLE — a wrong password stays wrong, unlike
 * the `421 too many connections` / `ECONNREFUSED` / timeout family, which is
 * deliberately absent so a busy server is never mistaken for a dead
 * credential.
 */
const PROTOCOL_AUTH_FAILURE_PATTERNS = [
  // SSH / SFTP (`ssh2`): every key and password offered was refused.
  "all configured authentication methods failed",
  // IMAP (RFC 5530) and the servers that phrase it themselves.
  "authenticationfailed",
  "authentication failed",
  "invalid credentials",
  "login failed",
  "login incorrect",
  // IMAP NO on LOGIN, POP3 -ERR — `nodemailer` surfaces SMTP 535 as EAUTH.
  "eauth",
  "the user name or password is incorrect",
];

/**
 * The same signal as a numeric status code, matched on a DIGIT boundary.
 *
 * A substring would not do, and the difference is not theoretical: a unit
 * test caught `"Transferred 1530 bytes"` matching a plain `"530 "` and
 * marking a perfectly good connection dead over a byte count. The leading
 * `(^|\D)` is what makes `530` the code rather than the tail of a number.
 *
 *  - SMTP 535 — authentication credentials invalid.
 *  - FTP 530 — not logged in.
 *  - HTTP 401 — Exchange/EWS behind Basic auth, and anything fronted by IIS.
 */
const PROTOCOL_AUTH_FAILURE_CODES = [
  { pattern: /(^|\D)535\s/, label: "SMTP 535" },
  { pattern: /(^|\D)530\s/, label: "FTP 530" },
  { pattern: /(^|\D)401\s+unauthorized/, label: "HTTP 401" },
];

/**
 * Auth-failure substrings to look for in the BODY of an `http-direct`
 * 403 response. http-direct providers use static API keys (no OAuth
 * refresh dance), so a 403 is usually a business-rule rejection (role
 * mismatch, missing account selector, resource-scope check) and NOT a
 * credential problem. We only flip the connection to `error` when the
 * body explicitly indicates the key is dead.
 *
 * Examples that should NOT trigger reconnection:
 *  - Shiptify: "User is not shipper", "User is not carrier"
 *  - any provider: "Missing required header", "Account not allowed for this resource"
 *
 * Examples that SHOULD trigger reconnection:
 *  - "Invalid API key", "API key has been revoked", "Account suspended"
 */
const HTTP_DIRECT_403_AUTH_BODY_PATTERNS = [
  "invalid api key",
  "api key is invalid",
  "api key invalid",
  "api key has been revoked",
  "api key revoked",
  "api key not found",
  "missing api key",
  "invalid token",
  "token expired",
  "token revoked",
  "authentication failed",
  "unauthenticated",
  "account suspended",
  "account disabled",
  "account deactivated",
];

/**
 * Classify a 4xx `http-direct` HTTP response — should this kill the
 * connection (user must reconnect with fresh credentials) or just
 * surface the error to the agent (transient / business-rule reject)?
 *
 * Rules:
 *  - 401: ALWAYS a credential failure. The API key is not recognised.
 *  - 403 + body matches an auth pattern: credential failure.
 *  - 403 without auth body: business rule (role / scope / resource).
 *    Surface to the agent, do NOT mark the connection broken.
 *  - other status: not a credential failure.
 */
export const isHttpDirectCredentialFailure = (
  status: number,
  body: string,
): { matched: boolean; reason: string } => {
  if (status === 401) {
    return {
      matched: true,
      reason: "HTTP 401: API key rejected by provider",
    };
  }
  if (status === 403) {
    const lower = body.toLowerCase();
    for (const pattern of HTTP_DIRECT_403_AUTH_BODY_PATTERNS) {
      if (lower.includes(pattern)) {
        return {
          matched: true,
          reason: `HTTP 403: credentials rejected (${pattern})`,
        };
      }
    }
  }
  return { matched: false, reason: "" };
};

export interface AuthFailureCheck {
  matched: boolean;
  /** Human-readable reason — written to `lastErrorMessage` when matched. */
  reason: string;
}

export const isAuthFailure = (error: unknown): AuthFailureCheck => {
  if (typeof error !== "object" || error === null) {
    return { matched: false, reason: "" };
  }
  const e = error as {
    response?: { status?: number; data?: unknown };
    status?: number;
    code?: string;
    message?: string;
  };

  const status = e.response?.status ?? e.status;
  const responseData = e.response?.data;
  const errorField = isRecord(responseData) ? responseData.error : undefined;
  const nangoCodeRaw = isRecord(errorField) ? errorField.code : undefined;
  const nangoCode = typeof nangoCodeRaw === "string" ? nangoCodeRaw : undefined;
  const nangoMessageRaw = isRecord(errorField) ? errorField.message : undefined;
  const nangoMessage =
    typeof nangoMessageRaw === "string" ? nangoMessageRaw.toLowerCase() : "";
  const errMessage = (e.message ?? "").toLowerCase();
  const haystack = `${nangoMessage}\n${errMessage}`;

  // 1. Authoritative Nango code — the most reliable signal.
  if (nangoCode !== undefined && NANGO_AUTH_FAILURE_CODES.has(nangoCode)) {
    return { matched: true, reason: `Nango: ${nangoCode}` };
  }

  // 2. 404 + unknown_connection — the Fretik row references a Nango
  //    connection that no longer exists. User must reconnect.
  if (status === 404 && nangoCode === "unknown_connection") {
    return { matched: true, reason: "Connection no longer exists in Nango" };
  }

  // 3. Direct 401/403 from the upstream API — token is valid but the
  //    provider refuses it (scope revoked by admin, user deactivated,
  //    MFA enforced, …).
  if (status === 401 || status === 403) {
    return {
      matched: true,
      reason: `HTTP ${status}: credentials rejected by provider`,
    };
  }

  // 4. Message pattern match — covers the empirical Nango refresh wrap
  //    (HTTP 400 + server_error) and all the provider passthrough
  //    variants. Checked regardless of status: a 500 from the provider
  //    can still carry `invalid_grant` in its body.
  for (const pattern of AUTH_FAILURE_MESSAGE_PATTERNS) {
    if (haystack.includes(pattern)) {
      return { matched: true, reason: `Auth failure: ${pattern}` };
    }
  }

  // 5. Protocol-level refusals from `custom-handler` providers (IMAP, SMTP,
  //    EWS, SFTP, FTP). No status code to read — the protocol's own words
  //    are the whole signal.
  for (const pattern of PROTOCOL_AUTH_FAILURE_PATTERNS) {
    if (haystack.includes(pattern)) {
      return { matched: true, reason: `Auth failure: ${pattern}` };
    }
  }
  for (const { pattern, label } of PROTOCOL_AUTH_FAILURE_CODES) {
    if (pattern.test(haystack)) {
      return { matched: true, reason: `Auth failure: ${label}` };
    }
  }

  return { matched: false, reason: "" };
};
