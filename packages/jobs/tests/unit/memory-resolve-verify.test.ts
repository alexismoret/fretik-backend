import type {
  DecisionAnswered,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  anchorJournalEntries,
  anchorQuestionId,
  buildAnchorQuestion,
  readAnchorVerdicts,
} from "../../src/lib/memory-resolve-verify";

/**
 * The resolver's second opinion on its review band. The band is symmetric
 * around one bar: confirm at or above it, drop at or below one minus it, and
 * every other case leaves the link as the resolver scored it.
 */

const answered = (
  probabilities: Record<string, number>,
  over: Partial<DecisionAnswered> = {},
): DecisionResponse => ({
  status: "answered",
  point: "memory.resolve.verify",
  policy: {
    mode: "on",
    questionVersion: 1,
    thresholds: { anc: 0.9 },
    minChosenProbability: {},
  },
  answers: Object.fromEntries(
    Object.entries(probabilities).map(([recordId, probability]) => [
      anchorQuestionId(recordId),
      { type: "boolean", probability },
    ]),
  ),
  missing: [],
  transport: "openrouter",
  latencyMs: 90,
  ...over,
});

describe("readAnchorVerdicts", () => {
  test("confirm at the bar, drop at one minus the bar, keep in between", () => {
    const { verdicts } = readAnchorVerdicts(
      answered({ a: 0.9, b: 0.1, c: 0.5, d: 0.11 }),
      ["a", "b", "c", "d"],
    );
    expect(Object.fromEntries(verdicts)).toEqual({
      a: "confirm",
      b: "drop",
      c: "keep",
      d: "keep",
    });
  });

  test("no answer keeps the resolver's own verdict", () => {
    expect(
      Object.fromEntries(readAnchorVerdicts(null, ["a"]).verdicts),
    ).toEqual({ a: "keep" });
    expect(
      Object.fromEntries(readAnchorVerdicts(answered({}), ["a"]).verdicts),
    ).toEqual({ a: "keep" });
  });

  test("shadow is reported so the caller acts on nothing", () => {
    const { shadow } = readAnchorVerdicts(
      answered(
        { a: 0.99 },
        {
          policy: {
            mode: "shadow",
            questionVersion: 1,
            thresholds: { anc: 0.9 },
            minChosenProbability: {},
          },
        },
      ),
      ["a"],
    );
    expect(shadow).toBe(true);
  });
});

describe("anchorJournalEntries", () => {
  test("one row per record, aimed at it, applied only when live and decisive", () => {
    const response = answered({ a: 0.95, b: 0.5 });
    const { verdicts } = readAnchorVerdicts(response, ["a", "b"]);
    const rows = anchorJournalEntries({
      organizationId: "org",
      teamId: "team",
      eventId: "e1",
      response,
      verdicts,
      shadow: false,
    });
    expect(rows.map((r) => [r.targetId, r.outcome, r.applied])).toEqual([
      ["a", "confirm", true],
      ["b", "keep", false],
    ]);
  });
});

describe("buildAnchorQuestion", () => {
  test("names the record, its kind and the matched words, and is valid", () => {
    const question = buildAnchorQuestion(
      {
        recordId: "r1",
        collectionId: "c1",
        label: "Northwind Ltd",
        confidence: 0.6,
        matchedText: "northwind",
        matchType: "trigram",
      },
      "Company",
    );
    expect(question.instructions).toContain("Northwind Ltd");
    expect(question.instructions).toContain("(Company)");
    expect(question.instructions).toContain('"northwind"');
    expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
  });
});
