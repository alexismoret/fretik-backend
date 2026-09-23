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
import {
  CANDIDATE_MAX_CHARS,
  type RecallGathered,
  type RecallSearchHit,
} from "./candidates";
import { buildVerbatimBlock, type VerbatimSelection } from "./verbatim";

/**
 * The `decision` recall mode: the recall judge's job, done by the decision
 * model, on the same turns.
 *
 * `adaptive` serves a confident gather deterministically and hands a weak one
 * to the judge, an LLM that reads the message and writes the block. The one
 * job only the judge could do is ABSTAIN: refuse a candidate that scores well
 * but does not answer the message. Here that job is one yes/no per candidate
 * ("does this help answer the message?"), and the kept candidates are rendered
 * by the verbatim renderer, unchanged, so the block is byte-for-byte the shape
 * every eval was measured on.
 *
 * How the renderer is reused without touching it: the gather is FILTERED to
 * the kept hits and their rerank scores are blanked. A hit with no score
 * clears every floor ("absence of evidence is not evidence of irrelevance"),
 * so the model's verdict, not the score that sent the turn here, decides; the
 * renderer's per-source caps and ordering still apply. Nothing kept is an
 * abstention. Any failure returns null, and the caller runs the judge.
 */

export const RECALL_POINT = "chat.recall-select";

export const relevanceQuestionId = (index: number): string =>
  `rel:c${index.toString()}`;

/** Knowledge hits first, then documents: the order questions are numbered in. */
export const candidateHits = (gathered: RecallGathered): RecallSearchHit[] => [
  ...gathered.knowledgeResults,
  ...gathered.documentResults,
];

export const buildRelevanceQuestions = (
  hits: readonly RecallSearchHit[],
): Record<string, DecisionQuestion> =>
  Object.fromEntries(
    hits.map((hit, i) => [
      relevanceQuestionId(i),
      {
        type: "boolean",
        instructions: [
          `Retrieved ${hit.sourceType.replace(/s$/, "")}:\n${hit.content.slice(0, CANDIDATE_MAX_CHARS)}`,
          "Does this help answer the person's message in the state?",
        ].join("\n\n"),
        criteria: {
          true: "It helps answer the message.",
          false: "It does not bear on the message.",
        },
      } satisfies DecisionQuestion,
    ]),
  );

/**
 * Per hit index: kept or not, or null when the model did not answer for
 * every candidate. A partial answer is not an answer here: judging half the
 * gather would abstain on the half nobody looked at.
 */
export const readRelevance = (
  response: DecisionResponse | null,
  count: number,
): { kept: boolean[] | null; shadow: boolean } => {
  if (response?.status !== "answered") return { kept: null, shadow: false };
  const kept: boolean[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = relevanceQuestionId(i);
    const p = probabilityOf(response.answers[id]);
    const bar = thresholdFor(response.policy, id);
    if (p === null || bar === undefined) {
      return { kept: null, shadow: response.policy.mode === "shadow" };
    }
    kept.push(p >= bar);
  }
  return { kept, shadow: response.policy.mode === "shadow" };
};

/** The gather narrowed to the kept hits, their scores blanked (see above). */
export const keepOnly = (
  gathered: RecallGathered,
  kept: readonly boolean[],
): RecallGathered => {
  const knowledgeCount = gathered.knowledgeResults.length;
  const unscored = (hit: RecallSearchHit): RecallSearchHit => ({
    ...hit,
    rerankScore: null,
  });
  return {
    ...gathered,
    knowledgeResults: gathered.knowledgeResults
      .filter((_, i) => kept[i] === true)
      .map(unscored),
    documentResults: gathered.documentResults
      .filter((_, i) => kept[knowledgeCount + i] === true)
      .map(unscored),
  };
};

export const relevanceJournalEntries = (params: {
  organizationId: string;
  teamId: string;
  conversationId: string;
  turnKey: string;
  hits: readonly RecallSearchHit[];
  response: DecisionResponse | null;
  kept: readonly boolean[] | null;
  applied: boolean;
}): JournalEntry[] =>
  params.hits.map((_, i) =>
    answerJournalEntry({
      organizationId: params.organizationId,
      teamId: params.teamId,
      point: RECALL_POINT,
      questionId: relevanceQuestionId(i),
      journalQuestionId: `rel:${params.turnKey}:${i.toString()}`,
      subjectType: "conversation",
      subjectId: params.conversationId,
      response: params.response,
      questionCount: params.hits.length,
      outcome:
        params.kept === null
          ? "unanswered"
          : params.kept[i]
            ? "kept"
            : "dropped",
      applied: params.applied,
    }),
  );

/**
 * The block, or null for "run the judge instead". Null on any failure, a
 * partial answer, or while the point is in shadow (journaled either way).
 */
export const selectByDecision = async (params: {
  gathered: RecallGathered;
  userMessage: string;
  recentTail?: string;
  teamId: string;
  organizationId: string;
  conversationId?: string;
  evaluator?: DecisionEvaluator;
}): Promise<VerbatimSelection | null> => {
  const hits = candidateHits(params.gathered);
  if (hits.length === 0) return null;
  try {
    const response = await (params.evaluator ?? inProcessEvaluator)(
      {
        point: RECALL_POINT,
        state: {
          message: params.userMessage,
          recent: params.recentTail ?? null,
        },
        questions: buildRelevanceQuestions(hits),
        ...(params.conversationId !== undefined
          ? { sessionId: params.conversationId }
          : {}),
      },
      { teamId: params.teamId, organizationId: params.organizationId },
    );
    const { kept, shadow } = readRelevance(response, hits.length);
    const applied = kept !== null && !shadow;
    if (params.conversationId !== undefined) {
      await recordDecisions(
        relevanceJournalEntries({
          organizationId: params.organizationId,
          teamId: params.teamId,
          conversationId: params.conversationId,
          turnKey: crypto.randomUUID(),
          hits,
          response,
          kept,
          applied,
        }),
      );
    }
    if (!applied) return null;
    return buildVerbatimBlock(keepOnly(params.gathered, kept));
  } catch (error) {
    console.warn(
      "[recall] decision select failed, handing the turn to the judge:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
