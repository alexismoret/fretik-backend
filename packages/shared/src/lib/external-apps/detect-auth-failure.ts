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
      reason: "HTTP 401 — API key rejected by provider",
    };
  }
  if (status === 403) {
    const lower = body.toLowerCase();
    for (const pattern of HTTP_DIRECT_403_AUTH_BODY_PATTERNS) {
      if (lower.includes(pattern)) {
        return {
          matched: true,
          reason: `HTTP 403 — credentials rejected (${pattern})`,
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
      reason: `HTTP ${status} — credentials rejected by provider`,
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

  return { matched: false, reason: "" };
};
