import type { DecisionResponse } from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  readWorth,
  WORTH_QUESTION,
  worthJournalEntry,
} from "../../../src/services/memory/distill-worth";

/**
 * "Anything worth remembering?" before the first episode of a conversation.
 * A memory not written is one the team never gets back, so only an
 * unmistakable no skips, and nothing that is not an answer ever does.
 */

const answered = (probability: number | null): DecisionResponse => ({
  status: "answered",
  point: "memory.distill.worth",
  policy: {
    questionVersion: 1,
    thresholds: { worth: 0.05 },
    minChosenProbability: {},
  },
  answers:
    probability === null ? {} : { worth: { type: "boolean", probability } },
  missing: [],
  transport: "openrouter",
  latencyMs: 60,
});

describe("readWorth", () => {
  test("only a probability under the bar skips", () => {
    expect(readWorth(answered(0.04))).toBe(true);
    expect(readWorth(answered(0.05))).toBe(false);
    expect(readWorth(answered(0.6))).toBe(false);
  });

  test("no answer never skips", () => {
    expect(readWorth(answered(null))).toBe(false);
    expect(readWorth(null)).toBe(false);
  });
});

describe("worthJournalEntry", () => {
  test("a skip is journaled as applied, with its probability and bar", () => {
    expect(
      worthJournalEntry({
        organizationId: "org",
        teamId: "team",
        conversationId: "c1",
        response: answered(0.01),
        skip: true,
      }),
    ).toMatchObject({
      point: "memory.distill.worth",
      subjectType: "conversation",
      subjectId: "c1",
      outcome: "skip",
      applied: true,
      probability: 0.01,
      threshold: 0.05,
    });
  });
});

describe("WORTH_QUESTION", () => {
  test("is valid on the wire", () => {
    expect(DecisionQuestionSchema.safeParse(WORTH_QUESTION).success).toBe(true);
  });
});
