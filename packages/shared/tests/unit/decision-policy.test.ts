import { describe, expect, test } from "bun:test";
import {
  chosenOf,
  probabilityOf,
  resolvePolicy,
  scoreOf,
  thresholdFor,
} from "../../src/decisions/policy";

/**
 * The bars a point is asked under, and how an answer is read against them.
 */

describe("resolvePolicy", () => {
  test("the echo carries the registry's bars and question version", () => {
    const policy = resolvePolicy("workflow.gate");
    expect(policy.echo).toEqual({
      questionVersion: 2,
      thresholds: { wf: 0.15 },
      minChosenProbability: {},
    });
  });

  test("a choice point echoes its minimum chosen probability", () => {
    expect(resolvePolicy("drive.file").echo.minChosenProbability).toEqual({
      folder: 0.5,
    });
  });
});

describe("reading answers", () => {
  test("a boolean reads as its probability, anything else as nothing", () => {
    expect(probabilityOf({ type: "boolean", probability: 0.4 })).toBe(0.4);
    expect(probabilityOf({ type: "score", score: 1 })).toBeNull();
    expect(probabilityOf(undefined)).toBeNull();
  });

  test("a choice reads its winner's probability and the confidence", () => {
    expect(
      chosenOf({
        type: "choice",
        choice: "a",
        probabilities: { a: 0.7, b: 0.3 },
        confidence: 0.6,
      }),
    ).toEqual({ choice: "a", probability: 0.7, confidence: 0.6 });
  });

  test("a missing confidence is null, never zero", () => {
    // Not reported is not low. The gateway reports none today.
    expect(chosenOf({ type: "choice", choice: "a" })).toEqual({
      choice: "a",
      probability: null,
      confidence: null,
    });
  });

  test("a score reads its position and confidence", () => {
    expect(scoreOf({ type: "score", score: 1.4, confidence: 0.8 })).toEqual({
      score: 1.4,
      confidence: 0.8,
    });
  });

  test("the bar is looked up by question family", () => {
    expect(
      thresholdFor(
        {
          questionVersion: 2,
          thresholds: { wf: 0.15 },
          minChosenProbability: {},
        },
        "wf:0199-abc",
      ),
    ).toBe(0.15);
  });
});
