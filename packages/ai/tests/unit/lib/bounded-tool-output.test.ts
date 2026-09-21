import { describe, expect, test } from "bun:test";
import {
  boundedText,
  boundErrorStream,
  ERROR_STREAM_BUDGET_CHARS,
  maybePersistLargeOutput,
} from "../../../src/lib/persisted-output";

/**
 * What a tool is allowed to put into the context.
 *
 * Measured on 4 299 production rows (2026-09-17): 355 assistant messages over
 * 200 KB, 18 over 800 KB, the largest 32 538 448 bytes ≈ 8 M tokens. The 17
 * that were not the already-fixed 2026-09-09 incident decompose as 6.4 MB of
 * `tool-python`, 1.5 MB of `tool-bash` and 488 KB of `tool-manageWorkflow` —
 * none of it microcompactable, because unlike a `read` those results cannot be
 * fetched again, so `microcompactMessages` leaves them verbatim forever. No
 * compaction design survives a single message of that size; the fix is at the
 * door, not downstream.
 *
 * Both sandbox tools DID call `maybePersistLargeOutput` — on their success
 * path only. The error branch returned above it, so a failing cell handed back
 * whatever the sandbox had printed. That is a defect of LINE ORDER, which is
 * why the test below is written against the shape of a failing call rather
 * than against the helper in isolation.
 */

const HUGE = "x".repeat(400_000);

describe("boundedText", () => {
  test("short text passes through untouched", () => {
    expect(boundedText("hello", 100)).toBe("hello");
  });

  test("keeps the head AND the tail", () => {
    // A Python traceback puts the exception on its LAST line, so a head-only
    // cut throws away the one line the model needs to react to.
    const text = `FIRST${"-".repeat(50_000)}LAST`;
    const bounded = boundedText(text, 1_000);
    expect(bounded.startsWith("FIRST")).toBe(true);
    expect(bounded.endsWith("LAST")).toBe(true);
    expect(bounded.length).toBeLessThan(1_200);
  });

  test("says how much it dropped", () => {
    expect(boundedText(HUGE, 1_000)).toContain("characters dropped");
  });
});

describe("boundErrorStream", () => {
  test("a huge stderr is cut to the budget even with nowhere to persist it", async () => {
    const bounded = await boundErrorStream(HUGE, undefined, "call-1", "stderr");
    expect(bounded.length).toBeLessThan(ERROR_STREAM_BUDGET_CHARS + 200);
  });

  test("an ordinary stderr is not touched", async () => {
    const text = "Traceback (most recent call last):\n  ZeroDivisionError";
    expect(await boundErrorStream(text, undefined, "call-1", "stderr")).toBe(
      text,
    );
  });

  test("two error streams together stay under one successful result's cap", async () => {
    // The invariant that was missing: a FAILED call must not cost more context
    // than a successful one. `DEFAULT_THRESHOLD_CHARS` is 32 000.
    const stdout = await boundErrorStream(HUGE, undefined, "c", "stdout");
    const stderr = await boundErrorStream(HUGE, undefined, "c", "stderr");
    expect(stdout.length + stderr.length).toBeLessThan(32_000);
  });
});

describe("maybePersistLargeOutput without a conversation", () => {
  test("bounds instead of returning the payload whole", async () => {
    // It used to return the content untouched — "truncating would be worse
    // than a slightly oversized tool turn". That held while "oversized" meant
    // a fat payload; on the measured rows it means 32.5 MB.
    const out = await maybePersistLargeOutput(HUGE, undefined, "call-1", 1_000);
    expect(typeof out).toBe("string");
    expect(out.length).toBeLessThan(1_500);
  });

  test("a small payload is still returned by value, not stringified", async () => {
    const payload = { stdout: "ok", stderr: "" };
    expect(await maybePersistLargeOutput(payload, undefined, "c")).toBe(
      payload,
    );
  });
});

/**
 * The line-order regression test.
 *
 * `python.ts` returned its error envelope at :304 and reached the barrier at
 * :327; `bash.ts` returned at :207 and reached it at :224. Reading the source
 * is the only way to assert that an early `return` has not been reintroduced
 * ABOVE the bounding call — a behavioural test would need a live sandbox
 * producing megabytes of stderr, which is not a unit test.
 */
describe("the error path is bounded BEFORE it returns", () => {
  const readSource = async (file: string): Promise<string> =>
    Bun.file(new URL(`../../../src/tools/${file}`, import.meta.url)).text();

  for (const file of ["python.ts", "bash.ts"]) {
    test(`${file} bounds stdout and stderr on its error branch`, async () => {
      const source = await readSource(file);
      // Both stream fields of the error envelope go through the bound.
      expect(source).toContain("stdout: await boundErrorStream(");
      expect(source).toContain("stderr: await boundErrorStream(");
      // And the bound is reached before the success path's barrier, which is
      // the ordering that was wrong.
      expect(source.indexOf("boundErrorStream(")).toBeLessThan(
        source.lastIndexOf("maybePersistLargeOutput(payload"),
      );
    });
  }
});
