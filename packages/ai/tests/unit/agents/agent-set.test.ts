import type { StepResult, ToolSet } from "ai";
import { describe, expect, test } from "bun:test";
import {
  loopGuardVerdict,
  stopOnRepeatedToolErrors,
  toolOutcomes,
} from "../../../src/agents/shared/agent-set";

/**
 * What the loop guard can see, and the loop that proved what it could not.
 *
 * Until 2026-09-14 the guard counted a strictly TRAILING run of identical
 * `{error, code}` tool results. Production then produced a turn where neither
 * half held: the failing call was refused by the SDK before the tool ran (a
 * `tool-error` content part, absent from `toolResults`), and the model
 * interleaved a call that SUCCEEDED, which reset the counter every other
 * call. 26 calls in four minutes, no brake, stopped by the user.
 */

/** Minimal step fixtures — the guard is shape-matched, like the real steps. */
const steps = (
  perStep: { toolName: string; input?: unknown; output: unknown }[][],
): StepResult<ToolSet>[] =>
  perStep.map((toolResults) => ({
    toolResults,
  })) as unknown as StepResult<ToolSet>[];

/** Steps carrying raw content parts, the shape the SDK actually produces. */
const contentSteps = (
  perStep: {
    type: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
  }[][],
): StepResult<ToolSet>[] =>
  perStep.map((content) => ({
    content,
    toolResults: content.filter((part) => part.type === "tool-result"),
  })) as unknown as StepResult<ToolSet>[];

const fail = (toolName: string, code: string, input?: unknown) => ({
  toolName,
  ...(input === undefined ? {} : { input }),
  output: { error: "boom", code },
});
const ok = (toolName: string, input?: unknown) => ({
  toolName,
  ...(input === undefined ? {} : { input }),
  output: { ok: true },
});

describe("loopGuardVerdict — failures", () => {
  test("nothing to report on no steps or no failures", () => {
    expect(loopGuardVerdict([]).failure).toBeNull();
    expect(loopGuardVerdict(steps([[ok("extract")]])).failure).toBeNull();
  });

  test("counts an identical-failure run across steps", () => {
    expect(
      loopGuardVerdict(
        steps([
          [fail("extract", "INVALID_SCHEMA")],
          [fail("extract", "INVALID_SCHEMA")],
          [fail("extract", "INVALID_SCHEMA")],
        ]),
      ).failure,
    ).toEqual({ count: 3, toolName: "extract", code: "INVALID_SCHEMA" });
  });

  test("counts parallel same-step failures", () => {
    expect(
      loopGuardVerdict(
        steps([
          [
            fail("extract", "INVALID_SCHEMA"),
            fail("extract", "INVALID_SCHEMA"),
          ],
        ]),
      ).failure?.count,
    ).toBe(2);
  });

  test("an interleaved SUCCESS of the same tool no longer resets the count", () => {
    // The 2026-09-14 alternation, exactly: a malformed `update` and a `list`
    // that works, over and over. The old rule saw a run of 1, forever.
    const alternating = steps(
      Array.from({ length: 6 }, (_, i) =>
        i % 2 === 0
          ? [fail("managePage", "INVALID_ARGS", { action: "update" })]
          : [ok("managePage", { action: "list" })],
      ),
    );
    expect(loopGuardVerdict(alternating).failure?.count).toBe(3);
  });

  test("a different tool or code is counted separately", () => {
    const verdict = loopGuardVerdict(
      steps([
        [fail("extract", "INVALID_SCHEMA")],
        [fail("python", "PYTHON_ERROR")],
        [fail("python", "PYTHON_ERROR")],
      ]),
    );
    expect(verdict.failure).toEqual({
      count: 2,
      toolName: "python",
      code: "PYTHON_ERROR",
    });
  });

  test("outcomes older than the window are forgotten", () => {
    // 4 failures, then 16 successes: the failures fall out of the window.
    const long = steps([
      ...Array.from({ length: 4 }, () => [fail("extract", "INVALID_SCHEMA")]),
      ...Array.from({ length: 16 }, (_, i) => [ok("read", { path: `f${i}` })]),
    ]);
    expect(loopGuardVerdict(long).failure).toBeNull();
  });
});

describe("loopGuardVerdict — input validation the tool never saw", () => {
  test("a tool-error content part counts as INVALID_INPUT", () => {
    const verdict = loopGuardVerdict(
      contentSteps([
        [{ type: "tool-error", toolName: "managePage", input: {} }],
        [{ type: "tool-error", toolName: "managePage", input: {} }],
      ]),
    );
    expect(verdict.failure).toEqual({
      count: 2,
      toolName: "managePage",
      code: "INVALID_INPUT",
    });
  });

  test("tool results still count when they arrive as content parts", () => {
    expect(
      toolOutcomes(
        contentSteps([
          [
            {
              type: "tool-result",
              toolName: "read",
              input: { path: "a" },
              output: { ok: true },
            },
          ],
        ]),
      ),
    ).toEqual([
      { toolName: "read", identity: 'read({"path":"a"})', code: null },
    ]);
  });
});

describe("loopGuardVerdict — identical calls", () => {
  test("counts a trailing run of byte-identical calls, successes included", () => {
    const repeated = steps(
      Array.from({ length: 4 }, () => [ok("managePage", { action: "list" })]),
    );
    expect(loopGuardVerdict(repeated).identical).toEqual({
      count: 4,
      toolName: "managePage",
    });
  });

  test("a varying caption is the same call — the model is told to vary it", () => {
    const repeated = steps([
      [ok("managePage", { action: "list", caption: "Listing pages" })],
      [ok("managePage", { action: "list", caption: "Listing all pages now" })],
    ]);
    expect(loopGuardVerdict(repeated).identical?.count).toBe(2);
  });

  test("key order is not a difference", () => {
    const repeated = steps([
      [ok("read", { path: "a.vue", limit: 5 })],
      [ok("read", { limit: 5, path: "a.vue" })],
    ]);
    expect(loopGuardVerdict(repeated).identical?.count).toBe(2);
  });

  test("a changed argument breaks the run", () => {
    const repeated = steps([
      [ok("read", { path: "a.vue" })],
      [ok("read", { path: "a.vue" })],
      [ok("read", { path: "b.vue" })],
    ]);
    expect(loopGuardVerdict(repeated).identical?.count).toBe(1);
  });
});

describe("stopOnRepeatedToolErrors", () => {
  test("fires only at the configured limit", async () => {
    const stop = stopOnRepeatedToolErrors<ToolSet>(3);
    const two = steps([
      [fail("extract", "INVALID_SCHEMA")],
      [fail("extract", "INVALID_SCHEMA")],
    ]);
    const three = steps([
      [fail("extract", "INVALID_SCHEMA")],
      [fail("extract", "INVALID_SCHEMA")],
      [fail("extract", "INVALID_SCHEMA")],
    ]);
    expect(await stop({ steps: two })).toBe(false);
    expect(await stop({ steps: three })).toBe(true);
  });

  test("a repeated call that never fails also reaches the limit", async () => {
    // A runaway need not fail: 725 identical successful calls in one trace
    // (2026-09-09) cost real money and produced nothing.
    const stop = stopOnRepeatedToolErrors<ToolSet>(3);
    const repeated = steps(
      Array.from({ length: 3 }, () => [ok("searchKnowledge", { q: "x" })]),
    );
    expect(await stop({ steps: repeated })).toBe(true);
  });
});

// A background launch (`backgroundRun: true`) deliberately has NO stop
// condition: the agent may keep working in the same turn, and the wait
// registry resumes the conversation once every launched task is settled.
