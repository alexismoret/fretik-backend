import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { JournalEntry } from "@fretik/shared/services/decisions/journal";
import { answerJournalEntry } from "@fretik/shared/services/decisions/journal-entry";

/**
 * The promoter's rule, checked instead of trusted.
 *
 * The nightly promotion may store a team fact only if it RECURS across the
 * episodes, and that has rested on the promoter's own word: a fact stated in
 * one conversation and echoed by the model can reach `learned/`, where every
 * future turn reads it. This asks, per proposed fact and per episode, "does
 * this episode state it?", and the rule is then counted in code: a new fact
 * needs two supporting episodes, a correction of an existing one needs one.
 */

export const SUPPORT_POINT = "memory.promote.support";

/** Supporting episodes a promotion needs, by what it does. */
export const REQUIRED_SUPPORT = { ADD: 2, UPDATE: 1 } as const;

export interface ProposedPromotion {
  action: "ADD" | "UPDATE";
  path: string;
  content: string;
}

/** Episodes are shown as E1, E2… so a question names one without a uuid. */
export const episodeTag = (index: number): string =>
  `E${(index + 1).toString()}`;

export const supportQuestionId = (
  promotionIndex: number,
  episodeIndex: number,
): string => `sup:${promotionIndex.toString()}-${episodeTag(episodeIndex)}`;

/**
 * Question version 2: an episode that SETS the fact — a decision, a rule, a
 * standing request ("from now on, send it as a PDF") — supports it. Version 1
 * asked only whether it stated or applied the fact, and the episode in which a
 * person asked for the rule sat at 0.48 against a bar of 0.5, one run in ten
 * refusing a preference the team had set and then followed. Measured
 * 2026-09-24, `evals:decisions`.
 */
export const buildSupportQuestions = (
  promotions: readonly ProposedPromotion[],
  episodeCount: number,
): Record<string, DecisionQuestion> => {
  const questions: Record<string, DecisionQuestion> = {};
  promotions.forEach((promotion, i) => {
    for (let j = 0; j < episodeCount; j += 1) {
      questions[supportQuestionId(i, j)] = {
        type: "boolean",
        instructions: [
          `Proposed team fact:\n${promotion.content.slice(0, 1_500)}`,
          `Does episode ${episodeTag(j)} state this fact, set it (a decision, a rule or a standing request), or describe the team acting on it?`,
        ].join("\n\n"),
        criteria: {
          true: `Episode ${episodeTag(j)} states, sets or applies this fact.`,
          false: `Episode ${episodeTag(j)} does not state, set or apply this fact.`,
        },
      };
    }
  });
  return questions;
};

export interface SupportVerdict {
  /** Per promotion index: how many episodes support it, or null if unanswered. */
  support: (number | null)[];
  /** Per promotion index: whether the count clears the rule. Unanswered → true
   * (the legacy path decides, as before the check existed). */
  allowed: boolean[];
}

export const readSupport = (
  response: DecisionResponse | null,
  promotions: readonly ProposedPromotion[],
  episodeCount: number,
): SupportVerdict => {
  const answered = response?.status === "answered" ? response : null;
  const support = promotions.map((_, i) => {
    let count = 0;
    for (let j = 0; j < episodeCount; j += 1) {
      const id = supportQuestionId(i, j);
      const p = probabilityOf(answered?.answers[id]);
      const bar = answered ? thresholdFor(answered.policy, id) : undefined;
      if (p === null || bar === undefined) return null;
      if (p >= bar) count += 1;
    }
    return count;
  });
  return {
    support,
    allowed: promotions.map((promotion, i) => {
      const count = support[i];
      return count === null || count === undefined
        ? true
        : count >= REQUIRED_SUPPORT[promotion.action];
    }),
  };
};

export const supportJournalEntries = (params: {
  organizationId: string;
  teamId: string;
  episodeIds: readonly string[];
  promotions: readonly ProposedPromotion[];
  response: DecisionResponse | null;
  verdict: SupportVerdict;
}): JournalEntry[] => {
  const questionCount = params.promotions.length * params.episodeIds.length;
  return params.promotions.flatMap((_, i) =>
    params.episodeIds.map((episodeId, j) =>
      answerJournalEntry({
        organizationId: params.organizationId,
        teamId: params.teamId,
        point: SUPPORT_POINT,
        questionId: supportQuestionId(i, j),
        // Keyed by the fact, not by its position in tonight's call: the same
        // episode checked against the same fact another night is one row.
        journalQuestionId: `sup:${params.promotions[i]?.path ?? i.toString()}`,
        subjectType: "episode",
        subjectId: episodeId,
        response: params.response,
        questionCount,
        outcome: params.verdict.allowed[i] ? "kept" : "dropped",
        applied: params.verdict.allowed[i] === false,
      }),
    ),
  );
};
