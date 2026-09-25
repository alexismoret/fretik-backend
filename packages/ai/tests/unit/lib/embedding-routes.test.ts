import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_PROVIDER_POLICY,
  firstToAnswer,
  QUERY_EMBEDDING_ROUTES,
  queryRoutesFor,
} from "../../../src/lib/embedding-routes";

/**
 * The query-embedding race. What it owes its caller: the first SUCCESS, the
 * losers cancelled, a failed route never ending the race on its own, and the
 * caller's deadline reported as itself.
 */

/** A route that answers only when cancelled — with the reason it was given. */
const hangUntilAborted = (
  signal: AbortSignal,
  seen: { reason?: unknown },
): Promise<string> =>
  new Promise<string>((_, reject) => {
    signal.addEventListener("abort", () => {
      seen.reason = signal.reason;
      reject(signal.reason instanceof Error ? signal.reason : new Error("?"));
    });
  });

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/**
 * What a promise rejected with. An explicit try/catch, not `.rejects`: Bun
 * types that matcher as synchronous, so its `await` lints away and the
 * assertion silently stops running.
 */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a rejection, got an answer");
};

describe("firstToAnswer", () => {
  test("the first answer wins, and the route still running is cancelled with a reason saying so", async () => {
    const seen: { reason?: unknown } = {};
    const answer = await firstToAnswer([
      () => after(5, "fast"),
      (signal) => hangUntilAborted(signal, seen),
    ]);
    expect(answer).toBe("fast");
    expect(seen.reason).toBeInstanceOf(DOMException);
    expect(seen.reason).toMatchObject({
      name: "AbortError",
      message: "another route answered first",
    });
  });

  test("a route that fails does not end the race", async () => {
    const answer = await firstToAnswer([
      () => Promise.reject(new Error("503 from the first provider")),
      () => after(10, "second"),
    ]);
    expect(answer).toBe("second");
  });

  test("every route failing throws one error naming each failure", async () => {
    const error = await rejectionOf(
      firstToAnswer([
        () => Promise.reject(new Error("503 from nebius")),
        () =>
          Promise.reject(new Error("Expected 2560-dim embedding, got 4096")),
      ]),
    );
    expect(String(error)).toContain(
      "every route failed: 503 from nebius; Expected 2560-dim embedding, got 4096",
    );
  });

  test("the caller's deadline ends the race, and reads as a timeout", async () => {
    const seen: { reason?: unknown } = {};
    const error = await rejectionOf(
      firstToAnswer(
        [
          (signal) => hangUntilAborted(signal, seen),
          (signal) => hangUntilAborted(signal, {}),
        ],
        AbortSignal.timeout(10),
      ),
    );
    expect(error).toMatchObject({ name: "TimeoutError" });
    // Every route saw the deadline, not a "lost the race" cancellation.
    expect(seen.reason).toMatchObject({ name: "TimeoutError" });
  });

  test("an empty list is a bug in the caller, not a hang", async () => {
    expect(String(await rejectionOf(firstToAnswer([])))).toContain(
      "nothing to run",
    );
  });
});

describe("QUERY_EMBEDDING_ROUTES", () => {
  test("a model with no measured routes gets none — one request, OpenRouter's routing", () => {
    expect(queryRoutesFor("some/unmeasured-embedding-model")).toEqual([]);
  });

  test("every listed model has at least one route, each provider named once", () => {
    for (const routes of Object.values(QUERY_EMBEDDING_ROUTES)) {
      expect(routes.length).toBeGreaterThan(0);
      expect(new Set(routes).size).toBe(routes.length);
    }
  });

  test("every route carries the same data policy: zero retention, no quantized endpoint", () => {
    // A quantized endpoint's vectors are not the corpus's vectors
    // (SiliconFlow's fp8 is why the floor exists).
    expect(EMBEDDING_PROVIDER_POLICY.zdr).toBe(true);
    expect(EMBEDDING_PROVIDER_POLICY.quantizations).not.toContain("fp8");
    expect(EMBEDDING_PROVIDER_POLICY.quantizations).not.toContain("int8");
  });
});
