import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { JournalEntry } from "@fretik/shared/services/decisions/journal";
import { answerJournalEntry } from "@fretik/shared/services/decisions/journal-entry";

/**
 * Before the distiller writes a conversation up as an episode: is there
 * anything in it to remember?
 *
 * Every conversation past four messages is distilled today, and a greeting
 * that ran to four messages costs a full LLM pass and leaves an episode that
 * competes for a retrieval slot with real work. Only an unmistakable "nothing
 * here" skips, and only for a conversation with no episode yet: once one
 * exists, re-distilling keeps it current whatever this says.
 */

export const WORTH_POINT = "memory.distill.worth";

export const WORTH_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "The state is a conversation between a person and a workplace assistant. Does it contain anything worth remembering for future work: a decision, a fact about the team's work, a preference, a result produced, or a question left open?",
  criteria: {
    true: "The conversation contains something worth remembering for future work.",
    false:
      "The conversation contains nothing worth remembering, such as a greeting or small talk only.",
  },
};

export const readWorth = (
  response: DecisionResponse | null,
): { skip: boolean; shadow: boolean } => {
  if (response?.status !== "answered") return { skip: false, shadow: false };
  const p = probabilityOf(response.answers["worth"]);
  const bar = thresholdFor(response.policy, "worth");
  return {
    skip: p !== null && bar !== undefined && p < bar,
    shadow: response.policy.mode === "shadow",
  };
};

export const worthJournalEntry = (params: {
  organizationId: string;
  teamId: string;
  conversationId: string;
  response: DecisionResponse | null;
  verdict: { skip: boolean; shadow: boolean };
}): JournalEntry =>
  answerJournalEntry({
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: WORTH_POINT,
    questionId: "worth",
    subjectType: "conversation",
    subjectId: params.conversationId,
    response: params.response,
    questionCount: 1,
    outcome: params.verdict.skip ? "skip" : "distill",
    applied: params.verdict.skip && !params.verdict.shadow,
  });
