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
 * The decision model answers with a probability. The classifier it replaced
 * (an LLM answering one word) is asked only when no probability came back, so
 * an outage costs one extra call on the turns it touches and nothing on the
 * others.
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

/** The model's verdict, or null when it did not answer. */
export const readContinuation = (
  response: DecisionResponse | null,
): boolean | null => {
  if (response?.status !== "answered") return null;
  const p = probabilityOf(response.answers["announce"]);
  const bar = thresholdFor(response.policy, "announce");
  return p === null || bar === undefined ? null : p >= bar;
};

export const continuationJournalEntry = (params: {
  organizationId: string;
  teamId: string;
  conversationId: string;
  turnKey: string;
  response: DecisionResponse | null;
  continued: boolean;
  /** False when the classifier decided because the model did not answer. */
  applied: boolean;
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

  const response = await (params.evaluator ?? inProcessEvaluator)(
    {
      point: CONTINUATION_POINT,
      state: { message: text },
      questions: { announce: CONTINUATION_QUESTION },
      ...(params.conversationId !== undefined
        ? { sessionId: params.conversationId }
        : {}),
    },
    { teamId: params.teamId, organizationId: params.organizationId },
  );
  const verdict = readContinuation(response);
  const continued = verdict ?? (await isAnnouncedActionStop(text));

  if (params.conversationId !== undefined) {
    // Not awaited: the turn is waiting on `continued`, not on the journal.
    void recordDecisions([
      continuationJournalEntry({
        organizationId: params.organizationId,
        teamId: params.teamId,
        conversationId: params.conversationId,
        turnKey: params.turnKey ?? crypto.randomUUID(),
        response,
        continued,
        applied: verdict !== null,
      }),
    ]).catch((error: unknown) => {
      console.warn(
        "[turn-continuation] decision journal write failed:",
        error instanceof Error ? error.message : error,
      );
    });
  }
  return continued;
};
