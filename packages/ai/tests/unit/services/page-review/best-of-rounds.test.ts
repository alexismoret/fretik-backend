import { describe, expect, test } from "bun:test";
import {
  BEST_ROUND_MARGIN,
  bestEarlierRound,
} from "../../../../src/services/page-review/page-session-store";

/**
 * Which round of a build the user ends up with.
 *
 * The loop used to hand back whatever it happened to finish on. Refinement is
 * not monotonic — a revision can trade one flaw for another — so the best page
 * is often mid-loop, and keeping the last one discarded it by construction.
 */

const round = (
  over: Partial<{
    round: number;
    versionNumber: number;
    score: number;
    gatePass: boolean;
  }> = {},
) => ({
  round: 1,
  versionNumber: 10,
  score: 8,
  gatePass: true,
  ...over,
});

describe("bestEarlierRound", () => {
  test("goes back to a clearly better earlier round", () => {
    const best = bestEarlierRound(
      [
        round({ round: 1, score: 8.2, versionNumber: 11 }),
        round({ round: 2, score: 6.5 }),
      ],
      { round: 2, score: 6.5 },
    );
    expect(best?.versionNumber).toBe(11);
  });

  test("keeps what is on screen when the last round is the best", () => {
    expect(
      bestEarlierRound(
        [round({ round: 1, score: 6.0 }), round({ round: 2, score: 7.9 })],
        { round: 2, score: 7.9 },
      ),
    ).toBeNull();
  });

  test("does not swap the page over the critic's own noise", () => {
    // A tenth of a point is variance, not improvement. Restoring on it would
    // shuffle pages for no reason and cost the user their latest fixes.
    expect(
      bestEarlierRound([round({ round: 1, score: 7.2 })], {
        round: 2,
        score: 7.2 - BEST_ROUND_MARGIN + 0.05,
      }),
    ).toBeNull();
  });

  test("never restores a round that failed its gate", () => {
    // A higher design score on a page with an empty overlay is a prettier
    // broken page. The gate is measured; the score is judged.
    expect(
      bestEarlierRound([round({ round: 1, score: 9.5, gatePass: false })], {
        round: 2,
        score: 6,
      }),
    ).toBeNull();
  });

  test("picks the highest when several earlier rounds beat the current one", () => {
    const best = bestEarlierRound(
      [
        round({ round: 1, score: 7.5, versionNumber: 11 }),
        round({ round: 2, score: 8.4, versionNumber: 12 }),
      ],
      { round: 3, score: 6.0 },
    );
    expect(best?.versionNumber).toBe(12);
  });

  test("a first round has nothing to go back to", () => {
    expect(bestEarlierRound([], { round: 1, score: 5 })).toBeNull();
    expect(
      bestEarlierRound([round({ round: 1, score: 5 })], { round: 1, score: 5 }),
    ).toBeNull();
  });
});
