import type { DecisionResponse } from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  CONTINUATION_QUESTION,
  continuationJournalEntry,
  decideContinuation,
  readContinuation,
} from "../../../src/services/turn-continuation/decide";

/**
 * Who decides whether a short, tool-less last message continues the turn.
 * The classifier until the point is live, the model after, and the
 * classifier again whenever the model had nothing to say.
 */

const answered = (
  probability: number | null,
  mode: "on" | "shadow",
): DecisionResponse => ({
  status: "answered",
  point: "chat.turn.continuation",
  policy: {
    mode,
    questionVersion: 1,
    thresholds: { announce: 0.7 },
    minChosenProbability: {},
  },
  answers:
    probability === null ? {} : { announce: { type: "boolean", probability } },
  missing: [],
  transport: "openrouter",
  latencyMs: 90,
});

describe("decideContinuation", () => {
  test("in shadow the classifier decides, whatever the model says", () => {
    expect(
      decideContinuation(readContinuation(answered(0.99, "shadow")), false),
    ).toBe(false);
    expect(
      decideContinuation(readContinuation(answered(0.01, "shadow")), true),
    ).toBe(true);
  });

  test("live, the model decides against its bar", () => {
    expect(
      decideContinuation(readContinuation(answered(0.7, "on")), false),
    ).toBe(true);
    expect(
      decideContinuation(readContinuation(answered(0.69, "on")), true),
    ).toBe(false);
  });

  test("live with no answer, the classifier decides", () => {
    expect(
      decideContinuation(readContinuation(answered(null, "on")), true),
    ).toBe(true);
    expect(decideContinuation(readContinuation(null), false)).toBe(false);
  });
});

describe("continuationJournalEntry", () => {
  test("each turn is its own row, labelled with the classifier's answer", () => {
    const row = continuationJournalEntry({
      organizationId: "org",
      teamId: "team",
      conversationId: "c1",
      turnKey: "t42",
      response: answered(0.2, "shadow"),
      continued: true,
      applied: false,
      classifier: true,
    });
    expect(row).toMatchObject({
      point: "chat.turn.continuation",
      questionId: "announce:t42",
      family: "announce",
      subjectId: "c1",
      outcome: "continue",
      applied: false,
      legacyLabel: "true",
      probability: 0.2,
    });
  });
});

describe("CONTINUATION_QUESTION", () => {
  test("is valid on the wire", () => {
    expect(
      DecisionQuestionSchema.safeParse(CONTINUATION_QUESTION).success,
    ).toBe(true);
  });
});
