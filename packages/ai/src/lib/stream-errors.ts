import { APICallError } from "ai";

/**
 * Turn-robustness primitives (chantier C4). A turn must never die in
 * silence: this module classifies streaming failures as transient
 * (worth a retry / a transparent failover) vs fatal, shapes the
 * structured error surfaced to the client, and bounds the wait on
 * per-turn context fragments.
 */

export type StreamErrorKind = "transient" | "fatal";

export interface StreamErrorClassification {
  readonly kind: StreamErrorKind;
  /** Stable machine code, e.g. "rate_limited" — drives telemetry + UI. */
  readonly reason: string;
  /** HTTP status when the error carried one (APICallError). */
  readonly statusCode?: number;
}

/**
 * Structured error surfaced over SSE when a turn fails after a tool
 * side-effect (or fatally). The client reads it off the `error` frame's
 * `errorText` (JSON), shows a retry affordance keyed on `retryable`, and
 * uses `resume` to decide whether to CONTINUE the turn (a tool already
 * ran — replaying it would repeat side effects) or regenerate fresh.
 */
export interface StructuredStreamError {
  readonly retryable: boolean;
  readonly code: string;
  readonly message: string;
  readonly resume: boolean;
}

/**
 * Sentinel `errorText` returned from `onError` when the turn body is
 * about to fail over transparently to the fallback model. The eval
 * harness and the chat client treat it as a no-op (no user-visible
 * error) — the fallback's answer follows on the same stream.
 */
export const FAILOVER_SENTINEL = "__fretik_transparent_failover__";

/** Pre-stream backoff before retrying the SAME model once (ms). */
export const PRIMARY_RETRY_BACKOFF_MS = 400;

/**
 * Reasons that, by construction, mean the provider rejected the request
 * BEFORE streaming any token — so a transparent re-stream on the
 * fallback model can't duplicate on-screen text or repeat a tool call.
 * `network_reset` is deliberately excluded: a mid-stream socket drop is
 * recovered by the resumable-stream reconnect (Redis buffer replay), not
 * a model swap, and it can land mid-output.
 */
const PRE_OUTPUT_TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "empty_provider_pool",
  "rate_limited",
  "request_timeout",
  "server_error",
  "provider_retryable",
]);

/**
 * Whether a classified error is safe to recover by transparently
 * re-streaming on the fallback model (pre-output provider failure).
 */
export const isTransparentlyRecoverable = (
  classification: StreamErrorClassification,
): boolean =>
  classification.kind === "transient" &&
  PRE_OUTPUT_TRANSIENT_REASONS.has(classification.reason);

const EMPTY_POOL_RE =
  /No endpoints found|no allowed providers|no available providers/i;
const NETWORK_RESET_RE =
  /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|socket hang up|fetch failed|terminated|network error/i;
const SCHEMA_RE =
  /TypeValidationError|InvalidPromptError|No object generated|invalid schema/i;

/**
 * Flatten an unknown error to a searchable string, unwrapping one level
 * of `.cause` (wrapped `fetch` failures nest the original underneath)
 * and folding in a Node-style `.code` when present. Uses `in` guards —
 * no `as` cast.
 */
const errorString = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (!(err instanceof Error)) return "";
  let text = `${err.name}: ${err.message}`;
  if ("code" in err && typeof err.code === "string") {
    text += ` | code: ${err.code}`;
  }
  if ("cause" in err && err.cause !== undefined && err.cause !== null) {
    const cause = err.cause;
    if (cause instanceof Error) {
      text += ` | cause: ${cause.name}: ${cause.message}`;
      if ("code" in cause && typeof cause.code === "string") {
        text += ` | cause.code: ${cause.code}`;
      }
    } else if (typeof cause === "string") {
      text += ` | cause: ${cause}`;
    }
  }
  return text;
};

const make = (
  kind: StreamErrorKind,
  reason: string,
  statusCode?: number,
): StreamErrorClassification =>
  statusCode === undefined ? { kind, reason } : { kind, reason, statusCode };

/**
 * Classify a streaming error. Transient = retry / failover is safe:
 * 429, 408, 5xx, an empty provider pool / ZDR-no-endpoints, network
 * resets, or any error the provider flagged `isRetryable`. Fatal =
 * replay won't help: auth (401/403), other 4xx, schema/validation.
 * Pure + synchronous, so `onError` (sync) and the failover seam reach
 * the same verdict from the same input.
 */
export const classifyStreamError = (
  err: unknown,
): StreamErrorClassification => {
  const text = errorString(err);
  const status = APICallError.isInstance(err) ? err.statusCode : undefined;

  // Empty pool / ZDR-no-endpoints is transient however it surfaces
  // (often a 404 body, sometimes a bare error frame) — check before the
  // status branches so it never falls through to `client_error`.
  if (EMPTY_POOL_RE.test(text))
    return make("transient", "empty_provider_pool", status);

  if (APICallError.isInstance(err)) {
    if (status === 429) return make("transient", "rate_limited", 429);
    if (status === 408) return make("transient", "request_timeout", 408);
    if (status !== undefined && status >= 500)
      return make("transient", "server_error", status);
    if (status === 401 || status === 403) return make("fatal", "auth", status);
    if (status !== undefined && status >= 400) {
      return err.isRetryable
        ? make("transient", "provider_retryable", status)
        : make("fatal", "client_error", status);
    }
    // Status-less APICallError (network layer): trust the provider flag.
    if (err.isRetryable) return make("transient", "provider_retryable");
  }

  if (NETWORK_RESET_RE.test(text)) return make("transient", "network_reset");
  if (SCHEMA_RE.test(text)) return make("fatal", "schema_validation");
  return make("fatal", "unknown");
};

/**
 * Parse a `Retry-After` header (delta-seconds form) into a clamped
 * backoff in ms. Ignores the HTTP-date form (rare from providers) and
 * any unparseable value. Clamp keeps a hostile header from stalling the
 * turn or hammering the provider.
 */
const RETRY_AFTER_MIN_MS = 250;
const RETRY_AFTER_MAX_MS = 2000;
export const retryAfterMs = (err: unknown): number | undefined => {
  if (!APICallError.isInstance(err)) return undefined;
  const header = err.responseHeaders?.["retry-after"];
  if (header === undefined) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isNaN(seconds) || seconds < 0) return undefined;
  return Math.min(
    RETRY_AFTER_MAX_MS,
    Math.max(RETRY_AFTER_MIN_MS, seconds * 1000),
  );
};

/**
 * Shape the wire error for a non-transparent failure. `resume` is set
 * by the caller from `toolExecuted`: a tool side-effect already
 * happened, so the client must continue the turn (the tool results are
 * persisted + replayed in history) rather than regenerate from scratch.
 */
export const toStructuredError = (
  classification: StreamErrorClassification,
  opts: { resume: boolean },
): StructuredStreamError => ({
  retryable: classification.kind === "transient",
  code: classification.reason,
  message:
    classification.kind === "transient"
      ? "The model connection dropped before finishing. Retry to continue."
      : "The model could not complete this turn.",
  resume: opts.resume,
});

/**
 * Race a promise against a soft timeout. On timeout, RESOLVES to
 * `fallback` (and logs) rather than rejecting — every caller already
 * has an empty fallback; this only bounds the wait so one slow source
 * can't hang the whole turn. The underlying promise is NOT cancelled;
 * it settles in the background and its result is discarded. A late
 * rejection is consumed by `Promise.race`, so it never goes unhandled.
 */
export const withSoftTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
): Promise<T> => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    handle = setTimeout(() => {
      console.warn(
        `[soft-timeout] ${label} exceeded ${ms.toString()}ms — using fallback`,
      );
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
};

/** Sleep helper for the pre-stream retry backoff. */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryFallbackResult<R> {
  readonly result: R;
  readonly servedBy: "primary" | "fallback";
}

/**
 * Run `primary`; on failure recover. A transient error (esp. 429) earns
 * ONE retry on the SAME primary after a short backoff (honouring
 * `Retry-After`) before spending `fallback` — the primary is the profile
 * the team/eval actually selected. A fatal error drops straight to
 * `fallback`. A fired abort re-raises (the user cancelled — nothing to
 * recover). `log` is injectable for tests; defaults to `console.warn`.
 */
export const streamWithRetryThenFallback = async <R>(opts: {
  primary: () => Promise<R>;
  fallback: () => Promise<R>;
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<RetryFallbackResult<R>> => {
  const log = opts.log ?? ((message: string) => console.warn(message));
  try {
    return { result: await opts.primary(), servedBy: "primary" };
  } catch (err) {
    if (opts.abortSignal?.aborted) throw err;
    const classification = classifyStreamError(err);
    if (classification.kind === "transient") {
      const backoffMs = retryAfterMs(err) ?? PRIMARY_RETRY_BACKOFF_MS;
      log(
        `primary transient (${classification.reason}) — retrying same model once in ${backoffMs.toString()}ms`,
      );
      await delay(backoffMs);
      if (opts.abortSignal?.aborted) throw err;
      try {
        return { result: await opts.primary(), servedBy: "primary" };
      } catch (retryErr) {
        if (opts.abortSignal?.aborted) throw retryErr;
        log(
          `primary retry failed (${classifyStreamError(retryErr).reason}) — falling back`,
        );
      }
    } else {
      log(`primary failed (fatal ${classification.reason}) — falling back`);
    }
    return { result: await opts.fallback(), servedBy: "fallback" };
  }
};
