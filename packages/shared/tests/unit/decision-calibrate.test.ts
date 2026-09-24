import { describe, expect, test } from "bun:test";
import {
  centesimalRange,
  recommendBooleanThreshold,
  recommendChoiceThreshold,
  sweepBoolean,
  sweepChoice,
} from "../../src/decisions/calibrate";

/**
 * The arithmetic a threshold change is argued from. A wrong count here moves
 * a bar in the wrong direction with a table to back it.
 */

describe("sweepBoolean", () => {
  const samples = [
    { probability: 0.02, label: false },
    { probability: 0.1, label: false },
    { probability: 0.12, label: true },
    { probability: 0.6, label: true },
    { probability: 0.9, label: false },
  ];

  test("a launch is refused strictly below the bar", () => {
    const [row] = sweepBoolean(samples, [0.1]);
    // 0.02 is refused, 0.10 sits ON the bar and launches.
    expect(row).toMatchObject({
      rightRefusals: 1,
      wrongRefusals: 0,
      wrongLaunches: 2,
    });
  });

  test("rates are shares of the TRUE answers, not of all samples", () => {
    const [row] = sweepBoolean(samples, [0.15]);
    expect(row?.wrongRefusalRate).toBe(1 / 2);
    expect(row?.savingRate).toBe(2 / 3);
  });

  test("the recommended bar is the highest one that holds the refusal cap", () => {
    const sweep = sweepBoolean(samples, [0.05, 0.11, 0.13]);
    expect(recommendBooleanThreshold(sweep, 0)).toBe(0.11);
    expect(
      recommendBooleanThreshold(sweepBoolean(samples, [0.7]), 0),
    ).toBeNull();
  });
});

describe("sweepChoice", () => {
  const samples = [
    { confidence: 0.9, probability: 0.8, choice: "a", label: "a" },
    { confidence: 0.8, probability: 0.7, choice: "b", label: "a" },
    { confidence: 0.95, probability: 0.4, choice: "a", label: "a" },
    { confidence: 0.99, probability: 0.9, choice: "__root__", label: "a" },
  ];

  test("abstaining and a weak winner are never counted as acting", () => {
    const [row] = sweepChoice(samples, [0.5], 0.5, "__root__");
    // The root answer and the 0.4 winner are out; two actions, one right.
    expect(row).toMatchObject({ acted: 2, precision: 0.5, coverage: 0.5 });
  });

  test("the recommended bar is the lowest one that reaches the precision", () => {
    const sweep = sweepChoice(samples, [0.5, 0.85, 0.9], 0.5, "__root__");
    expect(recommendChoiceThreshold(sweep, 0.95)).toBe(0.85);
  });

  test("a bar that acts on nothing is not a recommendation", () => {
    const sweep = sweepChoice(samples, [0.999], 0.5, "__root__");
    expect(recommendChoiceThreshold(sweep, 0.95)).toBeNull();
  });
});

describe("centesimalRange", () => {
  test("clean hundredths, both ends included", () => {
    expect(centesimalRange(0.05, 0.08)).toEqual([0.05, 0.06, 0.07, 0.08]);
  });
});
