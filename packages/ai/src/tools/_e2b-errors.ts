import {
  RateLimitError,
  SandboxError,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";

/**
 * Map an unexpected error thrown by the E2B-backed sandbox layer into
 * the structured `{ error, code }` shape every sandbox-backed tool
 * returns. Shared between `python` and `bash` so error surfacing stays
 * consistent.
 *
 * The codes are stable strings the model can branch on:
 * - `SANDBOX_NOT_FOUND`: E2B returned 404 — the sandbox was killed
 *   under us (max lifetime or external admin). The next tool call will
 *   recreate a fresh one and re-hydrate workspace files.
 * - `SANDBOX_TIMEOUT`: E2B request exceeded the SDK request timeout
 *   (NOT the same as the sandbox-wide 5-min runtime cap; that one
 *   surfaces as a connection error).
 * - `SANDBOX_RATE_LIMIT`: E2B throttled the request; the model should
 *   try again after a short back-off.
 * - `SANDBOX_UNAVAILABLE`: catch-all for transport / API errors.
 * - `INTERNAL_ERROR`: anything we didn't anticipate.
 */
export const mapE2BError = (
  err: unknown,
  context: string,
): { error: string; code: string } => {
  if (err instanceof SandboxNotFoundError) {
    return {
      error:
        "The conversation's sandbox no longer exists (E2B cleaned it up). The next call will spawn a fresh one — workspace files are re-hydrated from the hot cache automatically.",
      code: "SANDBOX_NOT_FOUND",
    };
  }
  if (err instanceof TimeoutError) {
    return {
      error: `Sandbox request timed out ${context}: ${err.message}`,
      code: "SANDBOX_TIMEOUT",
    };
  }
  if (err instanceof RateLimitError) {
    return {
      error: `Sandbox rate-limited ${context}: ${err.message}. Try again after a short delay.`,
      code: "SANDBOX_RATE_LIMIT",
    };
  }
  if (err instanceof SandboxError) {
    return {
      error: `Sandbox error ${context}: ${err.message}`,
      code: "SANDBOX_UNAVAILABLE",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: `Unexpected error ${context}: ${message}`,
    code: "INTERNAL_ERROR",
  };
};
