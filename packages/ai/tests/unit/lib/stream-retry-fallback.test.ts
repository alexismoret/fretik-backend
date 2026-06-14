/**
 * C4 pre-stream recovery orchestration: a transient failure (esp. 429)
 * earns ONE retry on the same primary before the fallback is spent; a
 * fatal failure drops straight to the fallback; a fired abort re-raises.
 * Function stubs stand in for the `.stream()` calls so the policy is
 * tested without a model.
 */

import { APICallError } from "ai";
import { describe, expect, test } from "bun:test";
import { streamWithRetryThenFallback } from "../../../src/lib/stream-errors";

const apiError = (statusCode: number, isRetryable?: boolean): APICallError =>
  new APICallError({
    message: `status ${statusCode.toString()}`,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });

const noLog = (): void => {
  /* silence */
};

describe("streamWithRetryThenFallback", () => {
  test("primary succeeds → servedBy primary, fallback untouched", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const out = await streamWithRetryThenFallback({
      primary: () => {
        primaryCalls++;
        return Promise.resolve("primary-ok");
      },
      fallback: () => {
        fallbackCalls++;
        return Promise.resolve("fallback-ok");
      },
      log: noLog,
    });
    expect(out).toEqual({
      result: "primary-ok",
      servedBy: "primary",
      retried: false,
    });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  test("transient 429 → ONE retry on primary, succeeds, fallback untouched", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const out = await streamWithRetryThenFallback({
      primary: () => {
        primaryCalls++;
        if (primaryCalls === 1) return Promise.reject(apiError(429));
        return Promise.resolve("primary-retry-ok");
      },
      fallback: () => {
        fallbackCalls++;
        return Promise.resolve("fallback-ok");
      },
      log: noLog,
    });
    expect(out).toEqual({
      result: "primary-retry-ok",
      servedBy: "primary",
      retried: true,
    });
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  test("fatal 400 → straight to fallback, NO retry", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const out = await streamWithRetryThenFallback({
      primary: () => {
        primaryCalls++;
        return Promise.reject(apiError(400));
      },
      fallback: () => {
        fallbackCalls++;
        return Promise.resolve("fallback-ok");
      },
      log: noLog,
    });
    expect(out).toEqual({
      result: "fallback-ok",
      servedBy: "fallback",
      retried: false,
    });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  test("transient twice → retry then fallback", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const out = await streamWithRetryThenFallback({
      primary: () => {
        primaryCalls++;
        return Promise.reject(apiError(503));
      },
      fallback: () => {
        fallbackCalls++;
        return Promise.resolve("fallback-ok");
      },
      log: noLog,
    });
    expect(out).toEqual({
      result: "fallback-ok",
      servedBy: "fallback",
      retried: true,
    });
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
  });

  test("aborted → re-raises, fallback never spent", async () => {
    const controller = new AbortController();
    controller.abort();
    let fallbackCalls = 0;
    let caught: unknown;
    try {
      await streamWithRetryThenFallback({
        primary: () => Promise.reject(apiError(429)),
        fallback: () => {
          fallbackCalls++;
          return Promise.resolve("fallback-ok");
        },
        abortSignal: controller.signal,
        log: noLog,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(APICallError);
    expect(fallbackCalls).toBe(0);
  });
});
