import { APICallError, InvalidToolInputError, NoSuchToolError } from "ai";

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
 * `traceId` carries the turn's Langfuse trace even when the turn dies
 * before its `finish` frame — without it an errored turn is untraceable
 * from the client/eval side (no messageMetadata ever arrives).
 */
export interface StructuredStreamError {
  readonly retryable: boolean;
  readonly code: string;
  readonly message: string;
  readonly resume: boolean;
  readonly traceId?: string;
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
  // The routing layer refused the request; nothing was generated, so a
  // transparent re-stream cannot duplicate anything.
  "gateway_error",
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

const TOOL_CALL_ERROR_RE =
  /AI_InvalidToolInputError|AI_NoSuchToolError|Invalid input for tool|No such tool/i;

/**
 * A tool-call shaping failure: the model produced input that fails a tool's
 * `inputSchema`, or named a tool that doesn't exist. In a multi-step run the AI
 * SDK already turns this into a recoverable `tool-error` part fed back to the
 * model (it self-corrects on the next step), so it must NOT be classified as a
 * fatal stream death — that would mislabel a recoverable retry as a turn
 * failure. Covers every tool, not just one.
 *
 * Matches by instance AND by name/message: the same error reaches the OUTER
 * stream handler re-wrapped (prototype lost), so `isInstance` alone misses it.
 */
export const isRecoverableToolCallError = (err: unknown): boolean =>
  InvalidToolInputError.isInstance(err) ||
  NoSuchToolError.isInstance(err) ||
  TOOL_CALL_ERROR_RE.test(errorString(err));

/**
 * "Routing found nobody to send this to."
 *
 * One condition, four spellings, because two transports each phrase it their
 * own way and each has more than one path to it. OpenRouter answers a 404 body
 * ("No endpoints found matching your data policy") when a filter — a
 * quantization floor, `require_parameters`, a ZDR restriction — empties the
 * pool; the Gateway answers `no_providers_available` with a `type`
 * discriminator, most often when a model has no zero-retention host for a
 * request that asked for one.
 *
 * It is classified TRANSIENT deliberately. The pool is a moving target: a host
 * that was rate-limited a minute ago is back, and the turn's own retry-then-
 * fallback rail is a better answer than a hard error the user has to read.
 */
const EMPTY_POOL_RE =
  /No endpoints found|no allowed providers|no available providers|no_providers_available|No ZDR .*providers available/i;

/**
 * The gateway's own 5xx envelope. Its errors carry a `type` discriminator, and
 * the retryable ones are worth separating from a plain upstream 500: they mean
 * the routing layer failed, not the model, so the same model on the same
 * transport is very likely to work on the next attempt.
 */
const GATEWAY_RETRYABLE_RE =
  /gateway_internal_error|gateway_upstream_error|gateway_timeout|GatewayError/i;
const NETWORK_RESET_RE =
  /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|socket hang up|fetch failed|terminated|network error/i;
const SCHEMA_RE =
  /TypeValidationError|InvalidPromptError|No object generated|invalid schema/i;

/** Cap on any single JSON-serialised error value (keeps logs bounded). */
const MAX_ERROR_JSON_CHARS = 2_000;

/**
 * JSON-serialise an unknown value, bounded and never throwing — the last
 * resort so a plain-object error never degrades to `[object Object]`.
 * `JSON.stringify` returns `undefined` on BigInt / a bare symbol; coalesce
 * to `String(value)`. A circular ref throws → caught, `String(value)`.
 */
const boundedJson = (value: unknown): string => {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(
      0,
      MAX_ERROR_JSON_CHARS,
    );
  } catch {
    return String(value);
  }
};

/**
 * Flatten a plain-object error to a searchable string. A provider/library
 * can surface a mid-stream failure as a raw object rather than an `Error`
 * (OpenRouter enqueues the parsed payload `{ code, message, type?, … }`,
 * sometimes wrapped one level in `.error`). Pull `code`/`message`/`type`
 * off the object AND off a one-level-nested `.error`, then fold the full
 * bounded JSON so nothing is lost. `in` guards only — no `as` cast.
 */
const objectErrorString = (obj: object): string => {
  const fields: string[] = [];
  const collect = (o: object): void => {
    if (
      "code" in o &&
      (typeof o.code === "string" || typeof o.code === "number")
    ) {
      fields.push(`code: ${String(o.code)}`);
    }
    if ("message" in o && typeof o.message === "string") {
      fields.push(`message: ${o.message}`);
    }
    if ("type" in o && typeof o.type === "string") {
      fields.push(`type: ${o.type}`);
    }
  };
  collect(obj);
  if ("error" in obj && typeof obj.error === "object" && obj.error !== null) {
    collect(obj.error);
  }
  const prefix = fields.length > 0 ? `${fields.join(" | ")} | ` : "";
  return `${prefix}${boundedJson(obj)}`;
};

/**
 * Flatten an unknown error to a searchable string, unwrapping one level
 * of `.cause` (wrapped `fetch` failures nest the original underneath)
 * and folding in a Node-style `.code` when present. A non-Error object is
 * serialised via `objectErrorString` (never `""` — an empty string
 * classifies as fatal/unknown and drops the root cause). Uses `in`
 * guards — no `as` cast.
 */
const errorString = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (err instanceof Error) {
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
      } else {
        text += ` | cause: ${boundedJson(cause)}`;
      }
    }
    return text;
  }
  if (typeof err === "object" && err !== null) return objectErrorString(err);
  return "";
};

/** A mid-stream provider error payload, extracted from a plain object. */
interface ProviderErrorPayload {
  readonly code?: number;
  readonly message: string;
}

/**
 * Extract an OpenRouter-style mid-stream provider error from a plain
 * object. The SDK enqueues the raw parsed `{ code, message, … }`,
 * sometimes wrapped one level in `.error`; `code` may be a string
 * ("502") or number. Returns undefined for `Error` instances (handled by
 * the APICallError / regex branches) and for objects without a string
 * `message`. `in` guards only — no `as` cast.
 */
const providerErrorPayload = (
  err: unknown,
): ProviderErrorPayload | undefined => {
  if (err instanceof Error || typeof err !== "object" || err === null) {
    return undefined;
  }
  const read = (o: object): ProviderErrorPayload | undefined => {
    if (!("message" in o) || typeof o.message !== "string") return undefined;
    const message = o.message;
    if ("code" in o) {
      const rawCode = o.code;
      if (typeof rawCode === "number") return { code: rawCode, message };
      if (typeof rawCode === "string") {
        const parsed = Number.parseInt(rawCode, 10);
        if (!Number.isNaN(parsed)) return { code: parsed, message };
      }
    }
    return { message };
  };
  const direct = read(err);
  if (direct !== undefined) return direct;
  if ("error" in err && typeof err.error === "object" && err.error !== null) {
    return read(err.error);
  }
  return undefined;
};

/**
 * Provider-error messages (no usable numeric code) that mean a transient
 * upstream hiccup — safe to retry. Kept narrow so a genuine bad-request
 * message isn't mislabelled retryable.
 */
const PROVIDER_ERROR_MESSAGE_RE =
  /provider (returned|error)|upstream error|internal server error|overloaded|temporarily unavailable|timed? ?out/i;

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

  // A failure of the ROUTING layer rather than of the model. Checked before the
  // status branches for the same reason as the pool: the gateway reports these
  // through several statuses, and the retry rail is the right answer to all of
  // them — the next attempt is very likely to land somewhere healthy.
  if (GATEWAY_RETRYABLE_RE.test(text))
    return make("transient", "gateway_error", status);

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

  // OpenRouter surfaces a mid-stream provider failure as a plain-object
  // error frame (not an APICallError): `{ code, message, … }`. Map it the
  // same way as an APICallError status so a provider 5xx / 429 that kills
  // the stream is retryable rather than fatal/unknown. Falls through to
  // the regex/unknown branches when the object carries no usable signal.
  const payload = providerErrorPayload(err);
  if (payload !== undefined) {
    const code = payload.code;
    if (code === 429) return make("transient", "rate_limited", 429);
    if (code === 408) return make("transient", "request_timeout", 408);
    if (code !== undefined && code >= 500)
      return make("transient", "server_error", code);
    if (code === 401 || code === 403) return make("fatal", "auth", code);
    if (code !== undefined && code >= 400)
      return make("fatal", "client_error", code);
    if (PROVIDER_ERROR_MESSAGE_RE.test(payload.message))
      return make("transient", "provider_error");
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
  opts: { resume: boolean; traceId?: string },
): StructuredStreamError => ({
  retryable: classification.kind === "transient",
  code: classification.reason,
  message:
    classification.kind === "transient"
      ? "The model connection dropped before finishing. Retry to continue."
      : "The model could not complete this turn.",
  resume: opts.resume,
  ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
});

/**
 * Full diagnostic string for a stream error: flattened name/message/
 * codes (+ one level of cause) AND the stack. For logs and the Langfuse
 * ERROR event — never for the wire (the client gets the structured
 * error above).
 */
export const describeStreamError = (err: unknown): string => {
  const text = errorString(err);
  if (err instanceof Error && err.stack !== undefined) {
    return `${text}\n${err.stack}`;
  }
  // Never `String(err)` for an object — that is the `[object Object]`
  // default that made errored turns undebuggable. `errorString` already
  // serialises objects, so this only guards a genuinely empty string.
  return text.length > 0 ? text : boundedJson(err);
};

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
  /** True when a same-model retry was attempted (transient pre-stream error). */
  readonly retried: boolean;
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
    return {
      result: await opts.primary(),
      servedBy: "primary",
      retried: false,
    };
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
        return {
          result: await opts.primary(),
          servedBy: "primary",
          retried: true,
        };
      } catch (retryErr) {
        if (opts.abortSignal?.aborted) throw retryErr;
        log(
          `primary retry failed (${classifyStreamError(retryErr).reason}) — falling back`,
        );
        return {
          result: await opts.fallback(),
          servedBy: "fallback",
          retried: true,
        };
      }
    }
    log(`primary failed (fatal ${classification.reason}) — falling back`);
    return {
      result: await opts.fallback(),
      servedBy: "fallback",
      retried: false,
    };
  }
};
