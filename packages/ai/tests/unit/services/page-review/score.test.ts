import { describe, expect, test } from "bun:test";
import {
  CRITIQUE_WEIGHTS,
  SHIP_SCORE,
  weightedScore,
} from "../../../../src/services/page-review/evaluate";

/**
 * The critic reports four observations and never a verdict. Weighting them and
 * deciding what ships happens here, in code it cannot see — which is what stops
 * a model from grading its way to a pass.
 */

describe("critique scoring", () => {
  test("the weights sum to one, so the score stays on the 0-10 scale", () => {
    const total = Object.values(CRITIQUE_WEIGHTS).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    expect(total).toBeCloseTo(1, 10);
    expect(
      weightedScore({
        design: 10,
        functionality: 10,
        craft: 10,
        originality: 10,
      }),
    ).toBe(10);
  });

  test("a page that renders correctly and decides nothing lands mid-scale", () => {
    // The rubric's own anchor: 5 everywhere is "generated, not wrong".
    const score = weightedScore({
      design: 5,
      functionality: 5,
      craft: 5,
      originality: 5,
    });
    expect(score).toBe(5);
    expect(score).toBeLessThan(SHIP_SCORE);
  });

  test("polish cannot buy its way past a page that could have been generated for anything", () => {
    // Craft and functionality maxed, design good, originality absent — the
    // exact profile of a competent generic dashboard. It must not ship.
    expect(
      weightedScore({
        design: 7,
        functionality: 10,
        craft: 10,
        originality: 2,
      }),
    ).toBeLessThan(SHIP_SCORE);
  });

  test("strong across the board ships", () => {
    expect(
      weightedScore({
        design: 8,
        functionality: 8,
        craft: 8,
        originality: 8,
      }),
    ).toBeGreaterThanOrEqual(SHIP_SCORE);
  });

  test("one soft axis no longer clears the bar on its own", () => {
    // 7.8 — the old threshold shipped this, and pages that scored here are
    // where "correct but ordinary" lives. It does not ship now; it spends an
    // elevation round first, and ships after it whatever the round bought.
    // The point is not that 7.8 is a bad page. It is that a loop which stops
    // at the first page it cannot fault never builds a better one.
    const score = weightedScore({
      design: 8,
      functionality: 8,
      craft: 8,
      originality: 7,
    });
    expect(score).toBe(7.8);
    expect(score).toBeLessThan(SHIP_SCORE);
  });
});
