import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import {
  recordDecisions,
  type JournalEntry,
} from "@fretik/shared/services/decisions/journal";
import { answerJournalEntry } from "@fretik/shared/services/decisions/journal-entry";
import type { DecisionEvaluator } from "@fretik/shared/services/decisions/remote";
import { inProcessEvaluator } from "../decisions/in-process";
import { isAnnouncedActionStop } from "./judge";

/**
 * Should a turn whose last message is short, after tool work, continue?
 *
 * Two readers of the same message, asked side by side so neither adds its
 * latency to the other: the classifier this replaces (an LLM answering one
 * word) and the decision model (a probability). Until the point is live the
 * classifier decides and the probability is journaled next to its answer,
 * which is the measurement the switch waits on. Once live, the probability
 * decides, and the classifier is the answer when no probability came back.
 */

export const CONTINUATION_POINT = "chat.turn.continuation";

export const CONTINUATION_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    'The state is the last message of an assistant turn that ended without calling a tool. Does it announce an action the assistant was about to perform, with no result delivered, such as "Let me check the records"?',
  criteria: {
    true: "The message announces an action and delivers no result.",
    false:
      "The message delivers a result: an answer, a confirmation of finished work, or a question to the user.",
  },
};

export const readContinuation = (
  response: DecisionResponse | null,
): { verdict: boolean | null; shadow: boolean } => {
  if (response?.status !== "answered") return { verdict: null, shadow: false };
  const p = probabilityOf(response.answers["announce"]);
  const bar = thresholdFor(response.policy, "announce");
  return {
    verdict: p === null || bar === undefined ? null : p >= bar,
    shadow: response.policy.mode === "shadow",
  };
};

/** The decision: the model's when it is live and answered, else the
 * classifier's. */
export const decideContinuation = (
  model: { verdict: boolean | null; shadow: boolean },
  classifier: boolean,
): boolean =>
  !model.shadow && model.verdict !== null ? model.verdict : classifier;

export const continuationJournalEntry = (params: {
  organizationId: string;
  teamId: string;
  conversationId: string;
  turnKey: string;
  response: DecisionResponse | null;
  continued: boolean;
  applied: boolean;
  classifier: boolean;
}): JournalEntry =>
  answerJournalEntry({
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: CONTINUATION_POINT,
    questionId: "announce",
    journalQuestionId: `announce:${params.turnKey}`,
    subjectType: "conversation",
    subjectId: params.conversationId,
    response: params.response,
    questionCount: 1,
    outcome: params.continued ? "continue" : "stop",
    applied: params.applied,
    legacyLabel: params.classifier ? "true" : "false",
  });

export const shouldContinueTurn = async (params: {
  finalText: string;
  teamId: string;
  organizationId: string;
  /** Absent on the stateless path: nothing to journal the verdict against. */
  conversationId?: string;
  /** The turn's own id, so each judgement is its own journal row. */
  turnKey?: string;
  evaluator?: DecisionEvaluator;
}): Promise<boolean> => {
  const text = params.finalText.trim();
  // An empty final step after tool work delivered nothing: dead by
  // definition, nothing to ask anyone.
  if (text.length === 0) return true;

  const [classifier, response] = await Promise.all([
    isAnnouncedActionStop(text),
    (params.evaluator ?? inProcessEvaluator)(
      {
        point: CONTINUATION_POINT,
        state: { message: text },
        questions: { announce: CONTINUATION_QUESTION },
        ...(params.conversationId !== undefined
          ? { sessionId: params.conversationId }
          : {}),
      },
      { teamId: params.teamId, organizationId: params.organizationId },
    ),
  ]);
  const model = readContinuation(response);
  const continued = decideContinuation(model, classifier);

  if (params.conversationId !== undefined) {
    await recordDecisions([
      continuationJournalEntry({
        organizationId: params.organizationId,
        teamId: params.teamId,
        conversationId: params.conversationId,
        turnKey: params.turnKey ?? crypto.randomUUID(),
        response,
        continued,
        applied: !model.shadow && model.verdict !== null,
        classifier,
      }),
    ]);
  }
  return continued;
};
