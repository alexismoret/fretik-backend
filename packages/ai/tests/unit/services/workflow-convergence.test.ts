import type { DecisionResponse } from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  CONVERGENCE_QUESTION,
  convergenceJournalEntry,
  readConvergence,
} from "../../../src/services/workflow-runs/convergence";

/**
 * The convergence score: measurement only. What is pinned is that it is
 * read against the echoed bar, recorded per turn of the run, and never
 * recorded as having changed anything.
 */

const answered = (score: number | null): DecisionResponse => ({
  status: "answered",
  point: "workflow.turn.convergence",
  policy: {
    mode: "shadow",
    questionVersion: 1,
    thresholds: { conv: 0.5 },
    minChosenProbability: {},
  },
  answers:
    score === null ? {} : { conv: { type: "score", score, confidence: 0.7 } },
  missing: [],
  transport: "openrouter",
  latencyMs: 110,
});

describe("readConvergence", () => {
  test("below the bar reads as stuck, at or above as moving", () => {
    expect(readConvergence(answered(0.3))).toEqual({ score: 0.3, stuck: true });
    expect(readConvergence(answered(0.5))).toEqual({
      score: 0.5,
      stuck: false,
    });
  });

  test("no answer is unscored, not stuck", () => {
    expect(readConvergence(answered(null))).toEqual({
      score: null,
      stuck: null,
    });
    expect(readConvergence(null)).toEqual({ score: null, stuck: null });
  });
});

describe("convergenceJournalEntry", () => {
  test("one row per turn of the run, the score kept, never applied", () => {
    expect(
      convergenceJournalEntry({
        organizationId: "org",
        teamId: "team",
        runId: "run-1",
        turnIndex: 4,
        response: answered(2.4),
      }),
    ).toMatchObject({
      subjectType: "workflow_run",
      subjectId: "run-1",
      questionId: "conv:4",
      family: "conv",
      score: 2.4,
      confidence: 0.7,
      outcome: "moving",
      applied: false,
    });
  });
});

describe("CONVERGENCE_QUESTION", () => {
  test("is a valid four-level score", () => {
    expect(DecisionQuestionSchema.safeParse(CONVERGENCE_QUESTION).success).toBe(
      true,
    );
  });
});
