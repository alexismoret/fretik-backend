import type { DecisionQuestion } from "@fretik/shared/schemas/decisions";
import { recordDecisions } from "@fretik/shared/services/decisions/journal";
import { answerJournalEntry } from "@fretik/shared/services/decisions/journal-entry";
import type { DecisionEvaluator } from "@fretik/shared/services/decisions/remote";
import { inProcessEvaluator } from "../decisions/in-process";

/**
 * Was that message for the assistant?
 *
 * In a conversation several people share, the assistant answers every
 * message, including the ones colleagues address to each other. Whether it
 * should stay quiet on those is a product decision nobody can make without
 * knowing how often it happens, so this measures it: the probability that
 * the message is addressed to the assistant, journaled per message.
 *
 * Measurement only, and fire-and-forget: it never delays a turn and never
 * changes one. Acting on it needs a way for a person to see that the
 * assistant stayed quiet and ask it to answer, which does not exist yet.
 */

export const ADDRESSEE_POINT = "chat.addressee";

export const ADDRESSEE_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "Several people share this conversation with an assistant. Each person's message starts with [Name]:. Is the latest message addressed to the assistant, rather than to the other people?",
  criteria: {
    true: "The latest message is addressed to the assistant.",
    false: "The latest message is addressed to the other people.",
  },
};

/** Characters kept per earlier message: enough to see who talks to whom. */
const RECENT_LINE_CHARS = 200;

export const measureAddressee = (params: {
  organizationId: string;
  teamId: string;
  conversationId: string;
  /** The turn's own id, so each message is its own journal row. */
  turnKey: string;
  participants: readonly string[];
  /** The latest message, with its `[Name]: ` prefix. */
  message: string;
  /** Earlier messages, oldest first, already speaker-prefixed. */
  recent: readonly string[];
  evaluator?: DecisionEvaluator;
}): void => {
  void (async () => {
    try {
      const response = await (params.evaluator ?? inProcessEvaluator)(
        {
          point: ADDRESSEE_POINT,
          subject: { type: "conversation", id: params.conversationId },
          sessionId: params.conversationId,
          state: {
            participants: params.participants.join(", "),
            message: params.message,
            recent: params.recent.map((line) =>
              line.slice(0, RECENT_LINE_CHARS),
            ),
          },
          questions: { addr: ADDRESSEE_QUESTION },
        },
        { teamId: params.teamId, organizationId: params.organizationId },
      );
      await recordDecisions([
        answerJournalEntry({
          organizationId: params.organizationId,
          teamId: params.teamId,
          point: ADDRESSEE_POINT,
          questionId: "addr",
          journalQuestionId: `addr:${params.turnKey}`,
          subjectType: "conversation",
          subjectId: params.conversationId,
          response,
          questionCount: 1,
          outcome: "measured",
          applied: false,
        }),
      ]);
    } catch (error) {
      console.warn(
        `[addressee] conversation ${params.conversationId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  })();
};
