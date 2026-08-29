/**
 * Turn-robustness primitives (C4): the stream-error classifier, the
 * `Retry-After` parser, the structured-error shaper, and the soft
 * timeout. The classifier is the load-bearing piece — a mislabel either
 * burns the fallback on a fatal error or hides a transient one.
 */

import { APICallError } from "ai";
import { describe, expect, test } from "bun:test";
import {
  classifyStreamError,
  delay,
  describeStreamError,
  isTransparentlyRecoverable,
  retryAfterMs,
  toStructuredError,
  withSoftTimeout,
} from "../../../src/lib/stream-errors";

const apiError = (opts: {
  statusCode?: number;
  isRetryable?: boolean;
  message?: string;
  responseHeaders?: Record<string, string>;
}): APICallError =>
  new APICallError({
    message: opts.message ?? "boom",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseHeaders: opts.responseHeaders,
    isRetryable: opts.isRetryable,
  });

describe("classifyStreamError", () => {
  test("429 → transient/rate_limited", () => {
    expect(classifyStreamError(apiError({ statusCode: 429 }))).toEqual({
      kind: "transient",
      reason: "rate_limited",
      statusCode: 429,
    });
  });

  test("408 → transient/request_timeout", () => {
    expect(classifyStreamError(apiError({ statusCode: 408 }))).toEqual({
      kind: "transient",
      reason: "request_timeout",
      statusCode: 408,
    });
  });

  test("503 → transient/server_error", () => {
    expect(classifyStreamError(apiError({ statusCode: 503 }))).toEqual({
      kind: "transient",
      reason: "server_error",
      statusCode: 503,
    });
  });

  test("a 4xx flagged isRetryable by the provider → transient/provider_retryable", () => {
    // 425 Too Early — not in our explicit set, but the provider says retry.
    expect(
      classifyStreamError(apiError({ statusCode: 425, isRetryable: true })),
    ).toEqual({
      kind: "transient",
      reason: "provider_retryable",
      statusCode: 425,
    });
  });

  test("empty provider pool (plain Error, not APICallError) → transient/empty_provider_pool", () => {
    const err = new Error(
      "No endpoints found matching your data policy (Zero data retention).",
    );
    expect(classifyStreamError(err)).toEqual({
      kind: "transient",
      reason: "empty_provider_pool",
    });
  });

  test("empty provider pool surfacing as a 404 APICallError → still transient", () => {
    const err = apiError({ statusCode: 404, message: "No endpoints found" });
    expect(classifyStreamError(err)).toEqual({
      kind: "transient",
      reason: "empty_provider_pool",
      statusCode: 404,
    });
  });

  // The gateway phrases the same condition its own way. Its wording is asserted
  // here rather than trusted, because a spelling this regex does not know falls
  // through to `client_error` — fatal, no retry, and the user reads it.
  test("gateway reports an empty pool as no_providers_available → transient", () => {
    const err = apiError({
      statusCode: 400,
      message:
        'No ZDR (Zero Data Retention) providers available for model: example/model-name. Providers considered: provider-a, provider-b {"type":"no_providers_available"}',
    });
    expect(classifyStreamError(err)).toEqual({
      kind: "transient",
      reason: "empty_provider_pool",
      statusCode: 400,
    });
  });

  test("gateway routing failure → transient/gateway_error, recoverable on the fallback", () => {
    const err = apiError({
      statusCode: 502,
      message: "GatewayError: gateway_upstream_error",
    });
    const classification = classifyStreamError(err);
    expect(classification).toEqual({
      kind: "transient",
      reason: "gateway_error",
      statusCode: 502,
    });
    // Nothing was generated, so re-streaming cannot duplicate on-screen text.
    expect(isTransparentlyRecoverable(classification)).toBe(true);
  });

  test("network reset → transient/network_reset", () => {
    expect(classifyStreamError(new Error("socket hang up"))).toEqual({
      kind: "transient",
      reason: "network_reset",
    });
    expect(classifyStreamError(new Error("ECONNRESET"))).toEqual({
      kind: "transient",
      reason: "network_reset",
    });
  });

  test("wrapped fetch failure (cause unwrap) → transient/network_reset", () => {
    const wrapped = new Error("fetch failed");
    Object.defineProperty(wrapped, "cause", {
      value: new Error("ECONNREFUSED"),
    });
    expect(classifyStreamError(wrapped)).toEqual({
      kind: "transient",
      reason: "network_reset",
    });
  });

  test("Node-style .code on the error is read (cause.code path)", () => {
    const wrapped = new Error("request to … failed");
    Object.defineProperty(wrapped, "cause", {
      value: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    expect(classifyStreamError(wrapped).kind).toBe("transient");
  });

  test("401/403 → fatal/auth", () => {
    expect(classifyStreamError(apiError({ statusCode: 401 }))).toEqual({
      kind: "fatal",
      reason: "auth",
      statusCode: 401,
    });
    expect(classifyStreamError(apiError({ statusCode: 403 }))).toEqual({
      kind: "fatal",
      reason: "auth",
      statusCode: 403,
    });
  });

  test("other 4xx (not retryable) → fatal/client_error", () => {
    expect(classifyStreamError(apiError({ statusCode: 400 }))).toEqual({
      kind: "fatal",
      reason: "client_error",
      statusCode: 400,
    });
  });

  test("schema/validation marker → fatal/schema_validation", () => {
    expect(
      classifyStreamError(new Error("TypeValidationError: bad shape")),
    ).toEqual({
      kind: "fatal",
      reason: "schema_validation",
    });
  });

  test("unknown shapes never throw → fatal/unknown", () => {
    expect(classifyStreamError(undefined)).toEqual({
      kind: "fatal",
      reason: "unknown",
    });
    expect(classifyStreamError("some opaque string")).toEqual({
      kind: "fatal",
      reason: "unknown",
    });
    expect(classifyStreamError({})).toEqual({
      kind: "fatal",
      reason: "unknown",
    });
  });

  // OpenRouter mid-stream failures arrive as a RAW plain object (not an
  // APICallError) — `{ code, message, ... }`, sometimes wrapped in `.error`,
  // and `code` may be a string. Before the fix these all fell through to
  // fatal/unknown (retryable:false), so a transient provider blip surfaced
  // to the user as an un-retryable death.
  describe("OpenRouter plain-object provider payloads", () => {
    test("numeric 5xx code → transient/server_error", () => {
      expect(
        classifyStreamError({ code: 502, message: "Provider returned error" }),
      ).toEqual({ kind: "transient", reason: "server_error", statusCode: 502 });
    });

    test("string code '429' is numeric-coerced → transient/rate_limited", () => {
      expect(
        classifyStreamError({ code: "429", message: "rate limited upstream" }),
      ).toEqual({ kind: "transient", reason: "rate_limited", statusCode: 429 });
    });

    test("408 → transient/request_timeout", () => {
      expect(classifyStreamError({ code: 408, message: "timed out" })).toEqual({
        kind: "transient",
        reason: "request_timeout",
        statusCode: 408,
      });
    });

    test("401/403 → fatal/auth", () => {
      expect(classifyStreamError({ code: 401, message: "no key" })).toEqual({
        kind: "fatal",
        reason: "auth",
        statusCode: 401,
      });
    });

    test("other 4xx → fatal/client_error", () => {
      expect(
        classifyStreamError({ code: 400, message: "bad request" }),
      ).toEqual({ kind: "fatal", reason: "client_error", statusCode: 400 });
    });

    test("wrapped `.error` payload is unwrapped one level", () => {
      expect(
        classifyStreamError({ error: { code: 503, message: "overloaded" } }),
      ).toEqual({ kind: "transient", reason: "server_error", statusCode: 503 });
    });

    test("no usable code but a provider-error message → transient/provider_error", () => {
      expect(
        classifyStreamError({
          code: null,
          message: "Provider returned error",
        }),
      ).toEqual({ kind: "transient", reason: "provider_error" });
    });

    test("object with a message but no provider signal stays fatal/unknown", () => {
      expect(
        classifyStreamError({ message: "something unexpected happened" }),
      ).toEqual({ kind: "fatal", reason: "unknown" });
    });

    test("empty-pool message on a provider payload wins over the code branch", () => {
      // The empty-pool check runs first (it can surface as a 404 body).
      expect(
        classifyStreamError({ code: 404, message: "No endpoints found" }),
      ).toMatchObject({ kind: "transient", reason: "empty_provider_pool" });
    });
  });
});

describe("retryAfterMs", () => {
  test("parses delta-seconds and clamps to [250, 2000]", () => {
    expect(
      retryAfterMs(
        apiError({ statusCode: 429, responseHeaders: { "retry-after": "1" } }),
      ),
    ).toBe(1000);
    expect(
      retryAfterMs(
        apiError({ statusCode: 429, responseHeaders: { "retry-after": "0" } }),
      ),
    ).toBe(250);
    expect(
      retryAfterMs(
        apiError({ statusCode: 429, responseHeaders: { "retry-after": "99" } }),
      ),
    ).toBe(2000);
  });

  test("undefined for missing / unparseable / non-APICallError", () => {
    expect(retryAfterMs(apiError({ statusCode: 429 }))).toBeUndefined();
    expect(
      retryAfterMs(
        apiError({
          statusCode: 429,
          responseHeaders: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
        }),
      ),
    ).toBeUndefined();
    expect(retryAfterMs(new Error("nope"))).toBeUndefined();
  });
});

describe("toStructuredError", () => {
  test("transient → retryable true; resume mirrors the side-effect flag", () => {
    const c = classifyStreamError(apiError({ statusCode: 429 }));
    expect(toStructuredError(c, { resume: true })).toEqual({
      retryable: true,
      code: "rate_limited",
      message:
        "The model connection dropped before finishing. Retry to continue.",
      resume: true,
    });
  });

  test("fatal → retryable false", () => {
    const c = classifyStreamError(apiError({ statusCode: 400 }));
    expect(toStructuredError(c, { resume: false })).toMatchObject({
      retryable: false,
      code: "client_error",
      resume: false,
    });
  });
});

describe("withSoftTimeout", () => {
  test("resolves with the promise value when it beats the timeout", async () => {
    const fast = Promise.resolve("real");
    expect(await withSoftTimeout(fast, 1000, "fallback", "fast")).toBe("real");
  });

  test("resolves to the fallback when the promise exceeds the bound", async () => {
    const stuck = new Promise<string>(() => {
      /* never resolves */
    });
    expect(await withSoftTimeout(stuck, 5, "fallback", "stuck")).toBe(
      "fallback",
    );
  });

  test("a late rejection (after the timeout fired) does not go unhandled", async () => {
    // If the wrapped promise rejects AFTER the soft timeout already
    // resolved to the fallback, Promise.race must still consume it.
    const lateReject = new Promise<string>((_, reject) => {
      setTimeout(() => {
        reject(new Error("late"));
      }, 10);
    });
    expect(await withSoftTimeout(lateReject, 2, "fallback", "late")).toBe(
      "fallback",
    );
    // Give the late rejection a tick to settle without crashing the test.
    await delay(20);
  });
});

describe("describeStreamError", () => {
  test("a plain-object error never degrades to '[object Object]'", () => {
    const out = describeStreamError({
      code: 502,
      message: "Provider returned error",
    });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("Provider returned error");
    expect(out).toContain("502");
  });

  test("a wrapped `.error` object still surfaces the inner message", () => {
    const out = describeStreamError({
      error: { code: 503, message: "overloaded" },
    });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("overloaded");
  });

  test("an Error keeps its message and stack", () => {
    const out = describeStreamError(new Error("kaboom"));
    expect(out).toContain("kaboom");
  });

  test("a circular object is tolerated (no throw, no '[object Object]')", () => {
    const circular: Record<string, unknown> = { message: "loop" };
    circular.self = circular;
    const out = describeStreamError(circular);
    expect(out).toContain("loop");
  });
});
