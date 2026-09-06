import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  pageBuilderHiddenTools,
  reviewHasRun,
} from "../../../../src/services/page-project/build-gate";

/**
 * `pageBuild` retires after the first review.
 *
 * Measured over three `page-giga-multi-view` builds on 2026-09-06: 10
 * `pageBuild` calls a page against 6.3 builds that changed a file and 6.3
 * reviews. `pageReview` had already started building the copy it judges, so
 * those calls bought nothing and cost a step each — about a sixth of what the
 * page spends.
 */

const toolResult = (toolName: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: `c-${toolName}`,
      toolName,
      output: { type: "json", value: { ok: true } },
    },
  ],
});

const toolCall = (toolName: string): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: `c-${toolName}`, toolName, input: {} },
  ],
});

const text = (value: string): ModelMessage => ({
  role: "user",
  content: value,
});

describe("reviewHasRun", () => {
  test("no review yet — the first build is still the builder's own", () => {
    expect(
      reviewHasRun([
        text("build me a page"),
        toolCall("pageWrite"),
        toolResult("pageWrite"),
        toolCall("pageBuild"),
        toolResult("pageBuild"),
      ]),
    ).toBe(false);
  });

  test("a review that came back retires the build tool", () => {
    expect(
      reviewHasRun([toolCall("pageReview"), toolResult("pageReview")]),
    ).toBe(true);
  });

  /**
   * The call is not the result. A review still in flight has produced no
   * findings, and the step that dispatched it is not a round that ended.
   */
  test("a review CALL with no result does not count", () => {
    expect(reviewHasRun([toolCall("pageReview")])).toBe(false);
  });

  test("a RED review counts — the next round is a fix, and a fix reviews", () => {
    // The compile failure comes back through the same result part, so this is
    // the same shape as a pass. It is also the exact round where the builder
    // used to reach for `pageBuild`.
    expect(
      reviewHasRun([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "pageReview",
              output: {
                type: "json",
                value: { ok: false, errors: ["Page.vue:12 unexpected token"] },
              },
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  test("a string-content message is walked past, not read as parts", () => {
    expect(reviewHasRun([text("pageReview")])).toBe(false);
  });

  test("an empty history is not a run that reviewed", () => {
    expect(reviewHasRun([])).toBe(false);
  });
});

describe("pageBuilderHiddenTools", () => {
  test("before a review, the base set passes through untouched", () => {
    const hidden = pageBuilderHiddenTools(
      ["manageMemory"],
      [toolResult("pageWrite")],
    );
    expect(hidden.has("pageBuild")).toBe(false);
    expect(hidden.has("manageMemory")).toBe(true);
  });

  test("after a review, pageBuild joins whatever was already hidden", () => {
    const hidden = pageBuilderHiddenTools(
      ["manageMemory"],
      [toolResult("pageReview")],
    );
    expect(hidden.has("pageBuild")).toBe(true);
    // The gate ADDS; it does not become the whole answer.
    expect(hidden.has("manageMemory")).toBe(true);
  });

  test("the base set is copied, never mutated", () => {
    const base = new Set(["manageMemory"]);
    pageBuilderHiddenTools(base, [toolResult("pageReview")]);
    expect(base.has("pageBuild")).toBe(false);
  });

  test("pageReview itself is never hidden — it is what replaces the build", () => {
    const hidden = pageBuilderHiddenTools([], [toolResult("pageReview")]);
    expect(hidden.has("pageReview")).toBe(false);
    expect(hidden.has("pageEdit")).toBe(false);
    expect(hidden.has("pageWrite")).toBe(false);
  });
});
