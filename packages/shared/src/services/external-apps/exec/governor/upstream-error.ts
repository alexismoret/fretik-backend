import { retryAfterFromHeaders } from "../../../../lib/http/retry-after";

/**
 * Reading a refusal off four transports that refuse differently.
 *
 * A 429 reaches this process in four shapes, and until now none of them was
 * read at all: `http-direct` threw a string-formatted `Error`, the Nango proxy
 * surfaced an axios-shaped object, a custom handler threw whatever its SDK
 * threw, and MCP answered a tool error. The status was in all four; nothing
 * looked.
 *
 * So the classifier is deliberately layered, most reliable first: a typed
 * error, then the axios shape (already read for 413 in `nango-proxy.ts`), then
 * — and only then — a pattern on the message. The pattern is the weak one and
 * it is last on purpose: `/\b429\b/` on a body would match an order number.
 */

/**
 * An HTTP refusal with its status and headers still attached.
 *
 * The message keeps the `EXTERNAL_APP_HTTP_FAILED:` prefix because
 * `isAuthFailure` matches on it, and a connection that stops being flagged as
 * broken is a user who stops being told to reconnect.
 */
export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string | undefined>,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UpstreamHttpError";
  }
}

/** The app asked us to slow down — raised instead of, or after, a real 429. */
export class UpstreamRateLimitedError extends Error {
  constructor(
    readonly connectionId: string,
    readonly displayName: string,
    readonly retryAfterMs: number,
    readonly reason: string,
  ) {
    super(
      `"${displayName}" is rate-limited right now (${reason}); it can be asked again in about ${Math.ceil(retryAfterMs / 1000).toString()}s. Ask it less often — raise a dataset's cacheTtlSeconds, fold several reads into one, or widen the connection's limit in its settings if the app allows more.`,
    );
    this.name = "UpstreamRateLimitedError";
  }
}

const RATE_LIMIT_PATTERN = /\b429\b|too many requests|rate[ _-]?limit/i;

/**
 * The `{ status, headers }` of an axios-shaped rejection, if there is one.
 * `in` narrowing all the way down — a cast here would be a promise about a
 * third party's error object that nothing checks.
 */
const responseOf = (
  error: unknown,
): { status: unknown; headers: unknown } | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("response" in error)) return undefined;
  const response: unknown = error.response;
  if (typeof response !== "object" || response === null) return undefined;
  return {
    status: "status" in response ? response.status : undefined,
    headers: "headers" in response ? response.headers : undefined,
  };
};

const headersOf = (value: unknown): Record<string, string | undefined> => {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string | undefined> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[name] = raw;
    else if (typeof raw === "number") out[name] = String(raw);
  }
  return out;
};

export interface UpstreamRefusal {
  /** How long the app says to wait, when it says. */
  retryAfterMs: number | undefined;
  /** What made us decide it was a refusal — for the log, and for the message. */
  detectedBy: "typed" | "axios" | "message";
}

/**
 * Is this error the app refusing us for asking too often? `undefined` when it
 * is anything else — a 500, a timeout, a business rule.
 */
export const classifyUpstreamError = (
  error: unknown,
  extraHeaderNames: readonly string[] = [],
  now: number = Date.now(),
): UpstreamRefusal | undefined => {
  if (error instanceof UpstreamHttpError) {
    if (error.status !== 429 && error.status !== 503) return undefined;
    return {
      retryAfterMs: retryAfterFromHeaders(error.headers, extraHeaderNames, now),
      detectedBy: "typed",
    };
  }

  const response = responseOf(error);
  if (response !== undefined && response.status === 429) {
    return {
      retryAfterMs: retryAfterFromHeaders(
        headersOf(response.headers),
        extraHeaderNames,
        now,
      ),
      detectedBy: "axios",
    };
  }

  // Last, and weakest: a handler or an MCP server that only ever gives us
  // prose. No headers to read, so the caller's default is the whole answer.
  const message = error instanceof Error ? error.message : "";
  if (message !== "" && RATE_LIMIT_PATTERN.test(message)) {
    return { retryAfterMs: undefined, detectedBy: "message" };
  }
  return undefined;
};
