/**
 * What a rendered page is worth, as an assertion reads it. Not a test file.
 *
 * Split from `page-design-judge.ts` so this half stays free of any runtime
 * import: the judge pulls the critic model, which resolves an OpenRouter client
 * at module load, and these are the rules a unit test needs to pin — chiefly
 * the one below about telling a broken RIG apart from a broken PAGE. Everything
 * here takes types only.
 */

import type { PageCritique } from "../src/services/page-review/evaluate";
import type { PageGateResult } from "../src/services/page-review/gate";
import type { CustomVerdict } from "./types";

export interface PageJudgement {
  /** Set when no browser was reachable — the rig failed, not the page. */
  degraded?: string;
  mounted: boolean;
  gate: PageGateResult;
  critique: PageCritique | null;
  /** Why there is no critique, when the render worked and the critic did not. */
  critiqueUnavailable?: string;
}

export const EMPTY_GATE: PageGateResult = {
  pass: false,
  blocking: [],
  observations: [],
};

/**
 * A rig failure and a broken page must not read the same. When no browser is
 * reachable the assertion FAILS rather than passing quietly — a baseline
 * recorded with a dead renderer is worse than a loud red line — but it says so
 * in the words "renderer unavailable", which no page defect ever produces.
 */
export const rigFailure = (degraded: string): string =>
  `renderer unavailable — ${degraded}. This is the eval rig, not the page: install a Chrome/Chromium or set PAGE_RENDER_BROWSER_WS, and PAGE_RUNTIME_DIR or APP_URL for the runtime assets.`;

/**
 * The measured half: the page mounted, its console is clean, every overlay a
 * click opens has content, every clickable target does something, nothing is
 * cut off at any width, and the emptied page still says something.
 */
export const gatePasses = (judgement: PageJudgement): true | string => {
  if (judgement.degraded !== undefined) return rigFailure(judgement.degraded);
  if (!judgement.mounted)
    return `the page never mounted${judgement.gate.blocking.length > 0 ? `: ${judgement.gate.blocking.join(" | ")}` : ""}`;
  if (!judgement.gate.pass)
    return `gate failed: ${judgement.gate.blocking.join(" | ")}`;
  return true;
};

/**
 * The judged half, graded. Passes above `floor`, and always reports the number
 * — the floor catches a collapse, the score is what the baseline compares.
 *
 * Set the floor at what a page must not fall below, not at what a good page
 * scores: the rubric puts "renders correctly and decides nothing" at 5, so a
 * floor of 5 asks the page to be better than the default output, and the
 * distance from there to `SHIP_SCORE` is the thing being improved.
 */
export const designScoreAtLeast = (
  judgement: PageJudgement,
  floor: number,
): CustomVerdict => {
  if (judgement.degraded !== undefined) {
    return { passed: false, score: 0, message: rigFailure(judgement.degraded) };
  }
  if (!judgement.critique) {
    return {
      passed: false,
      score: 0,
      message:
        judgement.critiqueUnavailable ??
        "the page never mounted, so there was nothing to judge",
    };
  }
  const { score, scores, summary } = judgement.critique;
  return {
    passed: score >= floor,
    // The raw 0-10 becomes the assertion's partial credit, so the run score
    // moves with the design and not only with the pass/fail.
    score: score / 10,
    message: `design ${score.toFixed(1)}/10 (design ${scores.design.toString()}, functionality ${scores.functionality.toString()}, craft ${scores.craft.toString()}, originality ${scores.originality.toString()}) — ${summary}`,
  };
};
