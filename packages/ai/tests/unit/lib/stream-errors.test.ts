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
