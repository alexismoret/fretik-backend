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

const answered = (
  probability: number | null,
  mode: "on" | "shadow" = "on",
): DecisionResponse => ({
  status: "answered",
  point: "memory.distill.worth",
  policy: {
    mode,
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
    expect(readWorth(answered(0.04)).skip).toBe(true);
    expect(readWorth(answered(0.05)).skip).toBe(false);
    expect(readWorth(answered(0.6)).skip).toBe(false);
  });

  test("no answer never skips", () => {
    expect(readWorth(answered(null)).skip).toBe(false);
    expect(readWorth(null).skip).toBe(false);
  });

  test("shadow is flagged so the distiller runs anyway", () => {
    expect(readWorth(answered(0.01, "shadow"))).toEqual({
      skip: true,
      shadow: true,
    });
  });
});

describe("worthJournalEntry", () => {
  test("a skip in shadow is journaled, and not as applied", () => {
    expect(
      worthJournalEntry({
        organizationId: "org",
        teamId: "team",
        conversationId: "c1",
        response: answered(0.01, "shadow"),
        verdict: { skip: true, shadow: true },
      }),
    ).toMatchObject({
      point: "memory.distill.worth",
      subjectType: "conversation",
      subjectId: "c1",
      outcome: "skip",
      applied: false,
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
