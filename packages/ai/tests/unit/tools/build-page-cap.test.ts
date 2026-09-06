import { describe, expect, test } from "bun:test";
import {
  emptyProjectState,
  writePageProject,
} from "../../../src/services/page-project/store";
import { admitBuildForTurn } from "../../../src/tools/build-page";

/**
 * One page build per turn, because every build of a turn IS the same build.
 *
 * The builder's scope is the turn's trace plus a constant `.page` suffix, so a
 * second dispatch shares the working copy, the pageId and the review budget of
 * the first — it resumes it with a fresh 80-step budget and no memory of what
 * the first found. Two docblocks claimed the opposite until 2026-09-06.
 *
 * The pull toward that second call is textual and real: six of
 * `formatBuildResult`'s branches end by naming `managePage { action:
 * "review" }`, and `managePage` answers that work found there "is
 * `buildPage`'s". Nothing in code closed the cycle.
 */

/** A fresh turn per test — the counter lives in Redis, keyed by it. */
const freshTurn = (): string => `trace-${crypto.randomUUID()}`;

const admit = async (traceId: string) =>
  await admitBuildForTurn({ traceId, conversationId: "conv-1" });

describe("admitBuildForTurn", () => {
  test("the first build of a turn is admitted", async () => {
    expect(await admit(freshTurn())).toBeNull();
  });

  test("a second build onto a page this turn made is refused, with the page", async () => {
    const traceId = freshTurn();
    await admit(traceId);
    await writePageProject(`${traceId}.page`, {
      ...emptyProjectState(),
      pageId: "page-1",
      files: { "Page.vue": "<template><p>x</p></template>" },
    });

    const refusal = await admit(traceId);

    expect(refusal).not.toBeNull();
    expect(refusal?.pageId).toBe("page-1");
    expect(refusal?.url).toBe("/pages/page-1");
    // The remedies that actually apply to a page that exists.
    expect(refusal?.summary).toContain("managePage");
    expect(refusal?.summary).toContain("review");
  });

  test("a second build is ADMITTED when the first saved no page", async () => {
    // `formatBuildResult` asks for exactly this retry when a run saved
    // nothing: there is no page to resume and nothing to review.
    const traceId = freshTurn();
    await admit(traceId);
    expect(await admit(traceId)).toBeNull();
  });

  test("a third empty build is refused rather than retried again", async () => {
    const traceId = freshTurn();
    await admit(traceId);
    await admit(traceId);

    const refusal = await admit(traceId);

    expect(refusal).not.toBeNull();
    expect(refusal?.pageId).toBeUndefined();
    expect(refusal?.summary).toContain("saved no page");
    expect(refusal?.summary).toContain("tell the user the build failed");
  });

  test("two turns do not share a count", async () => {
    const first = freshTurn();
    const second = freshTurn();
    await admit(first);
    await writePageProject(`${first}.page`, {
      ...emptyProjectState(),
      pageId: "page-1",
    });
    expect(await admit(first)).not.toBeNull();
    expect(await admit(second)).toBeNull();
  });
});
