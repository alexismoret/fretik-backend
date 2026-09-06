import { describe, expect, test } from "bun:test";
import {
  editedAfterLastReview,
  formatBuildResult,
  lastPageRef,
  type BuildSteps,
  type BuildTrajectory,
} from "../../../src/tools/build-page";

/**
 * The delegated build hands a page back to the app, not just prose.
 *
 * These pin the seam that was missing until 2026-08-20: `buildPage` returned a
 * summary and nothing else, so the workspace panel — which keys on the page
 * IDENTIFIER — had nothing to open. The recommended way to build a page was
 * the one way the finished page never appeared beside the conversation.
 */

const step = (results: { toolName: string; output: unknown }[]) => ({
  toolResults: results,
});

describe("lastPageRef", () => {
  test("reads the page out of a build result", () => {
    expect(
      lastPageRef([
        step([
          {
            toolName: "pageBuild",
            output: { pageId: "p1", url: "/pages/p1" },
          },
        ]),
      ]),
    ).toEqual({ pageId: "p1", url: "/pages/p1" });
  });

  test("takes the LAST page named — a build creates, then edits, then reviews", () => {
    expect(
      lastPageRef([
        step([{ toolName: "pageBuild", output: { pageId: "created" } }]),
        step([{ toolName: "describeCollection", output: { fields: [] } }]),
        step([{ toolName: "pageReview", output: { pageId: "reviewed" } }]),
      ])?.pageId,
    ).toBe("reviewed");
  });

  test("falls back to the canonical route when the result carries no url", () => {
    expect(
      lastPageRef([
        step([{ toolName: "pageBuild", output: { pageId: "p2" } }]),
      ]),
    ).toEqual({ pageId: "p2", url: "/pages/p2" });
  });

  test("skips error outputs and finds the page underneath them", () => {
    // A failed review after a good create still leaves a page worth opening.
    expect(
      lastPageRef([
        step([{ toolName: "pageBuild", output: { pageId: "p3" } }]),
        step([
          {
            toolName: "pageReview",
            output: { error: "boom", code: "INVALID_ARGS" },
          },
        ]),
      ])?.pageId,
    ).toBe("p3");
  });

  test("ignores other tools that happen to return an id-shaped object", () => {
    expect(
      lastPageRef([
        step([{ toolName: "manageRecord", output: { pageId: "not-a-page" } }]),
      ]),
    ).toBeUndefined();
  });

  test("a build that saved nothing names no page", () => {
    expect(
      lastPageRef([step([{ toolName: "querySql", output: { rows: [] } }])]),
    ).toBeUndefined();
    expect(lastPageRef([])).toBeUndefined();
  });
});

/**
 * The stale-review seam: whether the last scored review still describes the
 * page decides which recovery the parent is told to run — none, one confirming
 * review, or the full fix loop. Measured 2026-08-23: without this, a page that
 * had already passed review sent the parent through a whole duplicate
 * inspect→edit→review cycle.
 */
describe("editedAfterLastReview", () => {
  const reviewOutput = {
    pageId: "p1",
    gate: "pass",
    verdict: "ship",
    iteration: "2/5",
  };
  // `text` is part of the step shape the SUT reads, so a fixture that omits it
  // is not a step — it just happened to satisfy the fields this suite asserts
  // on. Empty is the honest value here: these cases are about tool calls.
  const fullStep = (
    calls: { toolCallId: string; toolName: string; input: unknown }[],
    results: { toolCallId: string; toolName: string; output: unknown }[],
  ) => ({ text: "", toolCalls: calls, toolResults: results });

  test("a review as the last page result means the page is as judged", () => {
    expect(
      editedAfterLastReview([
        fullStep(
          [{ toolCallId: "c1", toolName: "pageReview", input: {} }],
          [{ toolCallId: "c1", toolName: "pageReview", output: reviewOutput }],
        ),
      ]),
    ).toBe(false);
  });

  test("a write after the review makes it stale", () => {
    expect(
      editedAfterLastReview([
        fullStep(
          [
            { toolCallId: "c1", toolName: "pageReview", input: {} },
            {
              toolCallId: "c2",
              toolName: "pageEdit",
              input: { path: "Page.vue" },
            },
          ],
          [
            { toolCallId: "c1", toolName: "pageReview", output: reviewOutput },
            {
              toolCallId: "c2",
              toolName: "pageEdit",
              output: { path: "Page.vue", applied: true },
            },
          ],
        ),
      ]),
    ).toBe(true);
  });

  test("reads after the review settle nothing", () => {
    expect(
      editedAfterLastReview([
        fullStep(
          [
            { toolCallId: "c1", toolName: "pageReview", input: {} },
            {
              toolCallId: "c2",
              toolName: "pageRead",
              input: { path: "Page.vue" },
            },
          ],
          [
            { toolCallId: "c1", toolName: "pageReview", output: reviewOutput },
            {
              toolCallId: "c2",
              toolName: "pageRead",
              output: { path: "Page.vue", content: "…" },
            },
          ],
        ),
      ]),
    ).toBe(false);
  });

  test("with no review in the trajectory the write is reported — callers gate on a review existing first", () => {
    expect(
      editedAfterLastReview([
        fullStep(
          [
            {
              toolCallId: "c1",
              toolName: "managePage",
              input: { action: "create" },
            },
          ],
          [
            {
              toolCallId: "c1",
              toolName: "managePage",
              output: { pageId: "p1" },
            },
          ],
        ),
      ]),
    ).toBe(true);
  });
});

/**
 * What the PARENT reads back — the one channel that decides whether a build's
 * outcome costs a sentence or a second build.
 */

const buildResult = (over: {
  finishReason: string;
  text: string;
  steps?: BuildSteps;
}): BuildTrajectory => ({
  finishReason: over.finishReason,
  text: over.text,
  steps: over.steps ?? [],
});

const createdAndReviewed: BuildSteps = [
  {
    text: "",
    toolCalls: [{ toolCallId: "c1", toolName: "pageBuild", input: {} }],
    toolResults: [
      {
        toolCallId: "c1",
        toolName: "pageBuild",
        output: { pageId: "p1", url: "/pages/p1" },
      },
    ],
  },
  {
    text: "",
    toolCalls: [{ toolCallId: "c2", toolName: "pageReview", input: {} }],
    toolResults: [
      {
        toolCallId: "c2",
        toolName: "pageReview",
        output: {
          pageId: "p1",
          url: "/pages/p1",
          iteration: "1/5",
          gate: "pass",
          verdict: "revise",
          score: 7,
        },
      },
    ],
  },
];

describe("formatBuildResult", () => {
  test("a clean finish with words is passed through as the summary", () => {
    const out = formatBuildResult(
      buildResult({
        finishReason: "stop",
        text: "Built the page.",
        steps: createdAndReviewed,
      }),
    );
    expect(out.summary).toBe("Built the page.");
    expect(out.incomplete).toBeUndefined();
    expect(out.pageId).toBe("p1");
  });

  /**
   * Measured 2026-08-24 (`page-filterable-directory`): the builder's last step
   * ran 77s and returned zero tokens, the run still reported `stop`, and the
   * empty summary sent the parent to rebuild from zero — 454s and 33k tokens
   * for a page that already existed.
   */
  test("a clean finish with NOTHING said names the page and forbids a rebuild", () => {
    const out = formatBuildResult(
      buildResult({
        finishReason: "stop",
        text: "   ",
        steps: createdAndReviewed,
      }),
    );
    expect(out.incomplete).toBe(true);
    expect(out.pageId).toBe("p1");
    expect(out.summary).toContain("Do NOT call buildPage again");
    expect(out.summary).toContain("review");
    // The review facts still travel as a FIELD, not only as prose.
    expect(out.review?.verdict).toBe("revise");
  });

  test("said nothing AND saved nothing still asks for another build", () => {
    const out = formatBuildResult(
      buildResult({ finishReason: "stop", text: "" }),
    );
    expect(out.incomplete).toBe(true);
    expect(out.pageId).toBeUndefined();
    expect(out.summary).toContain("saved NO page");
  });

  test("a non-stop finish keeps its own diagnosis rather than the empty-summary one", () => {
    const out = formatBuildResult(
      buildResult({
        finishReason: "length",
        text: "",
        steps: createdAndReviewed,
      }),
    );
    expect(out.incomplete).toBe(true);
    expect(out.summary).toContain('finishReason="length"');
  });
});

/**
 * What the build cost travels on the result, whatever the result says.
 *
 * The branch that matters most is the FAILED one: a build that spent 40 steps
 * and saved nothing still spent them, and a price that only rides on success
 * makes the expensive failures the invisible ones.
 */
describe("formatBuildResult — the spend", () => {
  const spent = {
    steps: 31,
    inputTokens: 2_560_000,
    cacheReadTokens: 2_190_000,
    cacheWriteTokens: 12_000,
    outputTokens: 71_300,
    reasoningTokens: 24_800,
    costUsd: 0.71339,
    costedSteps: 31,
  };

  test("a clean build reports its steps and its price", () => {
    const out = formatBuildResult(
      buildResult({
        finishReason: "stop",
        text: "Built the page.",
        steps: createdAndReviewed,
      }),
      undefined,
      spent,
    );
    expect(out.usage?.steps).toBe(31);
    // Rounded, so a tenth of a cent does not reach the model as 16 digits.
    expect(out.usage?.costUsd).toBe(0.7134);
    expect(out.usage?.reasoningTokens).toBe(24_800);
  });

  test("a build that saved NOTHING still reports what it burned", () => {
    const out = formatBuildResult(
      buildResult({ finishReason: "stop", text: "" }),
      undefined,
      spent,
    );
    expect(out.summary).toContain("saved NO page");
    expect(out.usage?.steps).toBe(31);
  });

  test("a rescued build reports it too", () => {
    const out = formatBuildResult(
      buildResult({ finishReason: "length", text: "" }),
      { saved: true, pageId: "p9", url: "/pages/p9" },
      spent,
    );
    expect(out.pageId).toBe("p9");
    expect(out.usage?.costUsd).toBe(0.7134);
  });

  test("no ledger means no field — never a zero that reads as free", () => {
    const out = formatBuildResult(
      buildResult({
        finishReason: "stop",
        text: "Built the page.",
        steps: createdAndReviewed,
      }),
    );
    expect(out.usage).toBeUndefined();
  });
});
