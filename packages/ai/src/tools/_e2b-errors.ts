import {
  AuthenticationError,
  FileNotFoundError,
  NotEnoughSpaceError,
  RateLimitError,
  SandboxError,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * Map an unexpected error thrown by the E2B-backed sandbox layer into
 * the structured `{ error, code }` shape every sandbox-backed tool
 * returns. Shared between `python` and `bash` so error surfacing stays
 * consistent.
 *
 * A non-zero exit does NOT reach here: `commands.run` throws
 * `CommandExitError` for it, and `runInSandbox` unwraps that back into a
 * normal result so `stdout`/`stderr` survive. Anything that lands here is a
 * genuine infrastructure or configuration failure.
 *
 * The codes are stable strings the model can branch on:
 * - `SANDBOX_NOT_FOUND`: E2B returned 404 — the sandbox was killed
 *   under us (max lifetime or external admin). The next tool call will
 *   recreate a fresh one and restore workspace files.
 * - `SANDBOX_TIMEOUT`: E2B request exceeded the SDK request timeout
 *   (NOT the same as the sandbox-wide 5-min runtime cap; that one
 *   surfaces as a connection error).
 * - `SANDBOX_RATE_LIMIT`: E2B throttled the request; the model should
 *   try again after a short back-off.
 * - `SANDBOX_DISK_FULL`: the sandbox filesystem is full — the model can
 *   free space itself.
 * - `FILE_NOT_FOUND`: the path does not exist in the sandbox.
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
        "The conversation's sandbox no longer exists (E2B cleaned it up). The next call will spawn a fresh one — workspace files are restored from durable storage automatically.",
      code: TOOL_ERROR_CODES.SANDBOX_NOT_FOUND,
    };
  }
  if (err instanceof TimeoutError) {
    // The SDK's own message ends with "the 'timeoutMs' option can be used to
    // increase this timeout" — an option no tool exposes, so it sends the model
    // hunting for a knob that does not exist. Say what it can actually do.
    return {
      error: `Sandbox run timed out ${context} (5 min cap). Narrow the work: filter the query, fetch fewer rows, or split it across calls. Re-running the same code unchanged will time out again.`,
      code: TOOL_ERROR_CODES.SANDBOX_TIMEOUT,
    };
  }
  if (err instanceof RateLimitError) {
    return {
      error: `Sandbox rate-limited ${context}: ${err.message}. Try again after a short delay.`,
      code: TOOL_ERROR_CODES.SANDBOX_RATE_LIMIT,
    };
  }
  if (err instanceof NotEnoughSpaceError) {
    return {
      error: `Sandbox disk is full ${context}. Delete what you no longer need under /workspace (\`rm\` the intermediate files, \`outputs/results/\`) and re-run.`,
      code: TOOL_ERROR_CODES.SANDBOX_DISK_FULL,
    };
  }
  if (err instanceof FileNotFoundError) {
    return {
      error: `Path not found in the sandbox ${context}: ${err.message}. List the directory first — paths are relative to /workspace.`,
      code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
    };
  }
  if (err instanceof AuthenticationError) {
    // Server-side misconfiguration (bad or missing E2B key). No argument the
    // model can change fixes it, so send it elsewhere instead of into a retry.
    return {
      error: `Code execution is unavailable ${context} — the sandbox service rejected our credentials. Tell the user code execution is down, and finish the task without it if you can.`,
      code: TOOL_ERROR_CODES.SANDBOX_UNAVAILABLE,
    };
  }
  if (err instanceof SandboxError) {
    return {
      error: `Sandbox error ${context}: ${err.message}`,
      code: TOOL_ERROR_CODES.SANDBOX_UNAVAILABLE,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: `Unexpected error ${context}: ${message}`,
    code: TOOL_ERROR_CODES.INTERNAL_ERROR,
  };
};
