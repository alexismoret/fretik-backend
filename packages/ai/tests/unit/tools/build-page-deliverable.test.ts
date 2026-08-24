import { describe, expect, test } from "bun:test";
import {
  editedAfterLastReview,
  lastPageRef,
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
  test("reads the page out of a managePage result", () => {
    expect(
      lastPageRef([
        step([
          {
            toolName: "managePage",
            output: { pageId: "p1", url: "/pages/p1" },
          },
        ]),
      ]),
    ).toEqual({ pageId: "p1", url: "/pages/p1" });
  });

  test("takes the LAST page named — a build creates, then edits, then reviews", () => {
    expect(
      lastPageRef([
        step([{ toolName: "managePage", output: { pageId: "created" } }]),
        step([{ toolName: "describeObjectType", output: { fields: [] } }]),
        step([{ toolName: "managePage", output: { pageId: "reviewed" } }]),
      ])?.pageId,
    ).toBe("reviewed");
  });

  test("falls back to the canonical route when the result carries no url", () => {
    expect(
      lastPageRef([
        step([{ toolName: "managePage", output: { pageId: "p2" } }]),
      ]),
    ).toEqual({ pageId: "p2", url: "/pages/p2" });
  });

  test("skips error outputs and finds the page underneath them", () => {
    // A failed review after a good create still leaves a page worth opening.
    expect(
      lastPageRef([
        step([{ toolName: "managePage", output: { pageId: "p3" } }]),
        step([
          {
            toolName: "managePage",
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
    iteration: "2/3",
  };
  const fullStep = (
    calls: { toolCallId: string; toolName: string; input: unknown }[],
    results: { toolCallId: string; toolName: string; output: unknown }[],
  ) => ({ toolCalls: calls, toolResults: results });

  test("a review as the last managePage result means the page is as judged", () => {
    expect(
      editedAfterLastReview([
        fullStep(
          [
            {
              toolCallId: "c1",
              toolName: "managePage",
              input: { action: "review" },
            },
          ],
          [{ toolCallId: "c1", toolName: "managePage", output: reviewOutput }],
        ),
      ]),
    ).toBe(false);
  });

  test("an update after the review makes it stale", () => {
    expect(
      editedAfterLastReview([
        fullStep(
          [
            {
              toolCallId: "c1",
              toolName: "managePage",
              input: { action: "review" },
            },
            {
              toolCallId: "c2",
              toolName: "managePage",
              input: { action: "update" },
            },
          ],
          [
            { toolCallId: "c1", toolName: "managePage", output: reviewOutput },
            {
              toolCallId: "c2",
              toolName: "managePage",
              output: { pageId: "p1", updated: true },
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
            {
              toolCallId: "c1",
              toolName: "managePage",
              input: { action: "review" },
            },
            {
              toolCallId: "c2",
              toolName: "managePage",
              input: { action: "get" },
            },
          ],
          [
            { toolCallId: "c1", toolName: "managePage", output: reviewOutput },
            {
              toolCallId: "c2",
              toolName: "managePage",
              output: { pageId: "p1", definition: {} },
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
