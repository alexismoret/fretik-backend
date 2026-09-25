import { describe, expect, test } from "bun:test";
import {
  DecisionQuestionSchema,
  DecisionRequestSchema,
} from "../../src/schemas/decisions";

/**
 * The two provider constraints the wire enforces up front, so they surface
 * as a validation message at the call site instead of a 400 the engine can
 * only read as "our bug" after the fact.
 */

describe("DecisionQuestionSchema", () => {
  test("a boolean takes both criteria sides or neither", () => {
    expect(
      DecisionQuestionSchema.safeParse({
        type: "boolean",
        instructions: "Is it?",
      }).success,
    ).toBe(true);
    expect(
      DecisionQuestionSchema.safeParse({
        type: "boolean",
        instructions: "Is it?",
        criteria: { true: "yes", false: "no" },
      }).success,
    ).toBe(true);
    expect(
      DecisionQuestionSchema.safeParse({
        type: "boolean",
        instructions: "Is it?",
        criteria: { true: "yes" },
      }).success,
    ).toBe(false);
  });

  test("every rung of a score is described", () => {
    expect(
      DecisionQuestionSchema.safeParse({
        type: "score",
        instructions: "How much?",
        criteria: ["low", null, "high"],
      }).success,
    ).toBe(false);
  });

  test("a score has two to ten rungs", () => {
    const rungs = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `level ${i.toString()}`);
    const parse = (n: number): boolean =>
      DecisionQuestionSchema.safeParse({
        type: "score",
        instructions: "How much?",
        criteria: rungs(n),
      }).success;
    expect(parse(1)).toBe(false);
    expect(parse(2)).toBe(true);
    expect(parse(10)).toBe(true);
    expect(parse(11)).toBe(false);
  });

  test("a choice has two to 255 options", () => {
    const options = (n: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`o${i.toString()}`, "option"]),
      );
    const parse = (n: number): boolean =>
      DecisionQuestionSchema.safeParse({
        type: "choice",
        instructions: "Which?",
        criteria: options(n),
      }).success;
    expect(parse(1)).toBe(false);
    expect(parse(255)).toBe(true);
    expect(parse(256)).toBe(false);
  });
});

describe("DecisionRequestSchema", () => {
  test("a request names a known point", () => {
    const base = {
      state: { filename: "a.pdf" },
      questions: { "wf:1": { type: "boolean", instructions: "Is it?" } },
    };
    expect(
      DecisionRequestSchema.safeParse({ ...base, point: "workflow.gate" })
        .success,
    ).toBe(true);
    expect(
      DecisionRequestSchema.safeParse({ ...base, point: "nowhere" }).success,
    ).toBe(false);
  });
});
