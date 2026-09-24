import type {
  DecisionRequest,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import type { DecisionEvaluator } from "@fretik/shared/services/decisions/remote";
import { describe, expect, test } from "bun:test";
import {
  CONTINUATION_QUESTION,
  continuationJournalEntry,
  readContinuation,
  shouldContinueTurn,
} from "../../../src/services/turn-continuation/decide";
import {
  resolveModel,
  setResolveModelTripwire,
} from "../../lib/resolve-model-double";

/**
 * Who decides whether a short, tool-less last message continues the turn:
 * the decision model against its bar, and the classifier it replaced only
 * when the model had nothing to say.
 */

const answered = (probability: number | null): DecisionResponse => ({
  status: "answered",
  point: "chat.turn.continuation",
  policy: {
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

const evaluatorAnswering =
  (response: DecisionResponse | null): DecisionEvaluator =>
  (_request: DecisionRequest) =>
    Promise.resolve(response);

const base = {
  finalText: "Let me check the supplier records.",
  teamId: "team",
  organizationId: "org",
};

describe("readContinuation", () => {
  test("the model decides against its bar", () => {
    expect(readContinuation(answered(0.7))).toBe(true);
    expect(readContinuation(answered(0.69))).toBe(false);
  });

  test("no answer is no verdict", () => {
    expect(readContinuation(answered(null))).toBeNull();
    expect(readContinuation(null)).toBeNull();
  });
});

describe("shouldContinueTurn", () => {
  test("an answer decides without ever reaching the classifier", async () => {
    setResolveModelTripwire("the classifier ran on a turn the model decided");
    expect(
      await shouldContinueTurn({
        ...base,
        evaluator: evaluatorAnswering(answered(0.92)),
      }),
    ).toBe(true);
    expect(
      await shouldContinueTurn({
        ...base,
        evaluator: evaluatorAnswering(answered(0.1)),
      }),
    ).toBe(false);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  test("no answer hands the turn to the classifier", async () => {
    // The tripwire makes the classifier's model call throw, which it reads
    // as "unsure → stop": the call was made, and its fallback rule held.
    setResolveModelTripwire("classifier reached");
    expect(
      await shouldContinueTurn({
        ...base,
        evaluator: evaluatorAnswering(null),
      }),
    ).toBe(false);
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  test("an empty final step continues, with nobody asked", async () => {
    setResolveModelTripwire("an empty step reached a model");
    const asked: DecisionRequest[] = [];
    expect(
      await shouldContinueTurn({
        ...base,
        finalText: "   ",
        evaluator: (request) => {
          asked.push(request);
          return Promise.resolve(null);
        },
      }),
    ).toBe(true);
    expect(asked).toHaveLength(0);
    expect(resolveModel).not.toHaveBeenCalled();
  });
});

describe("continuationJournalEntry", () => {
  test("each turn is its own row, applied when the model decided", () => {
    const row = continuationJournalEntry({
      organizationId: "org",
      teamId: "team",
      conversationId: "c1",
      turnKey: "t42",
      response: answered(0.2),
      continued: false,
      applied: true,
    });
    expect(row).toMatchObject({
      point: "chat.turn.continuation",
      questionId: "announce:t42",
      family: "announce",
      subjectId: "c1",
      outcome: "stop",
      applied: true,
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
