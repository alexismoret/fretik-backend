import type { ModelMessage } from "ai";

/**
 * When `pageBuild` stops being a tool and becomes a duplicate.
 *
 * Until 2026-09-06 `pageReview` refused a working copy that had changed since
 * the last build, so a fix round cost edit → `pageBuild` → `pageReview`. The
 * refusal is gone and `pageReview` now builds the copy it is about to judge,
 * which was supposed to remove the middle call. It did not: measured over
 * three `page-giga-multi-view` builds, the builder called `pageBuild` 10 times
 * per page for 6.3 builds that changed a file, against 6.3 reviews. The
 * refusal had been the only thing making the redundancy visible; removing it
 * left the habit and hid the cost.
 *
 * So the tool retires instead. The FIRST build stays explicit — its compile
 * errors arrive before anything has paid for a render, and the page does not
 * exist yet — and from the first review onwards `pageReview` is the only way
 * to compile. Nothing is lost by that: a red build returns from `pageReview`
 * in the shape `pageBuild` returned, before any render, and a green one saves
 * the page exactly as `pageBuild` did.
 *
 * Cost, at ~$0.025 a step on Gemini 3.7 Flash: about 9 steps of 61, a sixth of
 * what a page spends.
 */

const REVIEW_TOOL = "pageReview";
const BUILD_TOOL = "pageBuild";

/** A tool-result part, structurally — the SDK's union is wider than we need. */
const isReviewResult = (part: unknown): boolean =>
  typeof part === "object" &&
  part !== null &&
  Reflect.get(part, "type") === "tool-result" &&
  Reflect.get(part, "toolName") === REVIEW_TOOL;

/**
 * Whether a review has already come back in this run.
 *
 * Read from the transcript rather than from Redis because `prepareStep` is
 * synchronous, and because the transcript is the same thing the model is
 * reasoning from: if it cannot see a review, it has not had one.
 *
 * A review that came back RED counts. It built, it reported, and the next
 * round is a fix — which is exactly the round `pageBuild` must not be in.
 */
export const reviewHasRun = (messages: readonly ModelMessage[]): boolean => {
  for (const message of messages) {
    const { content } = message;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isReviewResult(part)) return true;
    }
  }
  return false;
};

/**
 * The builder's hidden set for one step: whatever the policy and workflow gates
 * already hide, plus `pageBuild` from the first review onwards.
 *
 * A function rather than two lines in `prepareStep` so the decision is testable
 * whole. A test that only pinned `reviewHasRun` would still pass with the
 * composition deleted, which is the shape of test that reports a saving nobody
 * is making.
 */
export const pageBuilderHiddenTools = (
  base: Iterable<string>,
  messages: readonly ModelMessage[],
): Set<string> => {
  const hidden = new Set(base);
  if (reviewHasRun(messages)) hidden.add(BUILD_TOOL);
  return hidden;
};
