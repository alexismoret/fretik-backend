import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { RecordAnchor } from "@fretik/shared/services/collection-records/anchor";
import { buildAnchorQuestion } from "@fretik/shared/services/collection-records/anchor-verify";
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
 * The recall judge's job, done by the decision model, on the same turns.
 *
 * `adaptive` serves a confident gather deterministically and escalates a weak
 * one. The judge it escalated to is an LLM that reads the message and writes
 * the block, and the one job only it could do is ABSTAIN: refuse a candidate that scores well
 * but does not answer the message. Here that job is one yes/no per candidate
 * ("does this help answer the message?"), and the kept candidates are rendered
 * by the verbatim renderer, unchanged, so the block is byte-for-byte the shape
 * every eval was measured on.
 *
 * How the renderer is reused without touching it: the gather is FILTERED to
 * the kept hits and the knowledge hits' rerank scores are blanked. A hit with
 * no score clears every floor ("absence of evidence is not evidence of
 * irrelevance"), so the model's verdict, not the score that sent the turn
 * here, decides; the renderer's per-source caps and ordering still apply.
 * Nothing kept is an abstention. Any failure returns null, and the caller
 * runs the judge.
 *
 * Two things the judge used to refuse are asked too, because the renderer
 * passes them through on its own (question version 2; measured 2026-09-24,
 * `evals:recall` against main, both cases 0/10 without them):
 * - the RECORDS the message's words matched (anchors, and the graph lines and
 *   episodes hanging off them). "Quel horizon de placement…" matched the
 *   project Horizon by name, every candidate was rightly dropped, and the
 *   block still came out — made of the homonym's graph. Each anchor gets the
 *   `memory.resolve.verify` question, measured on exactly this confusion;
 * - a kept DOCUMENT keeps its score. The renderer admits a document only when
 *   it tops the ranking, and a blanked score never does: the lease the model
 *   kept at 0.97 for "et pour la caution ?" was dropped at rendering.
 */

export const RECALL_POINT = "chat.recall-select";

export const anchorSelectQuestionId = (index: number): string =>
  `anc:a${index.toString()}`;

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
): boolean[] | null => {
  if (response?.status !== "answered") return null;
  const kept: boolean[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = relevanceQuestionId(i);
    const p = probabilityOf(response.answers[id]);
    const bar = thresholdFor(response.policy, id);
    if (p === null || bar === undefined) return null;
    kept.push(p >= bar);
  }
  return kept;
};

/** One question per record the message's words matched, in anchor order. */
export const buildAnchorSelectQuestions = (
  anchors: readonly RecordAnchor[],
): Record<string, DecisionQuestion> =>
  Object.fromEntries(
    anchors.map((anchor, i) => [
      anchorSelectQuestionId(i),
      buildAnchorQuestion(anchor, null),
    ]),
  );

/** Per anchor: kept or not, or null unless every anchor was answered. */
export const readAnchorSelection = (
  response: DecisionResponse | null,
  count: number,
): boolean[] | null => {
  if (response?.status !== "answered") return null;
  const kept: boolean[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = anchorSelectQuestionId(i);
    const p = probabilityOf(response.answers[id]);
    const bar = thresholdFor(response.policy, id);
    if (p === null || bar === undefined) return null;
    kept.push(p >= bar);
  }
  return kept;
};

/**
 * The gather narrowed to what was kept. Knowledge scores are blanked (see
 * above); document scores are not, because the renderer's document gate
 * needs one. A dropped anchor takes its graph lines with it, and a graph
 * episode stays only while one of the anchors it hangs off does.
 */
export const keepOnly = (
  gathered: RecallGathered,
  kept: readonly boolean[],
  keptAnchors: readonly boolean[] = gathered.anchors.map(() => true),
): RecallGathered => {
  const knowledgeCount = gathered.knowledgeResults.length;
  const anchors = gathered.anchors.filter((_, i) => keptAnchors[i] === true);
  const anchorIds = new Set(anchors.map((a) => a.recordId));
  const anchorLabels = new Set(anchors.map((a) => a.label));
  const graph = gathered.graph;
  const perAnchor = (graph?.perAnchor ?? []).filter((a) =>
    anchorIds.has(a.recordId),
  );
  const episodes = (graph?.episodes ?? []).filter((episode) =>
    episode.anchorLabels.some((label) => anchorLabels.has(label)),
  );
  return {
    ...gathered,
    anchors,
    graph:
      graph === null || (perAnchor.length === 0 && episodes.length === 0)
        ? null
        : {
            rendered: perAnchor.flatMap((a) => a.lines).join("\n"),
            perAnchor,
            episodes,
          },
    knowledgeResults: gathered.knowledgeResults
      .filter((_, i) => kept[i] === true)
      .map((hit) => ({ ...hit, rerankScore: null })),
    documentResults: gathered.documentResults.filter(
      (_, i) => kept[knowledgeCount + i] === true,
    ),
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
      applied: params.kept !== null,
    }),
  );

/**
 * The block, or null for "run the judge instead". Null on any failure or a
 * partial answer.
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
  const { anchors } = params.gathered;
  if (hits.length === 0 && anchors.length === 0) return null;
  // A message that NAMES a record, exactly or approximately, asks before
  // anything else which record it means — and telling near names apart is
  // where the decision model is measured weak: on "…la mission avec Nordwind
  // Consulting" it kept Nordwind GmbH's episodes at 0.71–0.84 under two
  // wordings (`rec-vicious-confusable` 0/10; the judge, 10/10), and it read
  // the typo "Norwind Gmbh" at 0.71–0.77, astride any bar that also refuses
  // a homonym (0.62). Those turns stay with the judge. A word matched in a
  // record's TEXT ("et pour" in a supplier's notes) is noise it refuses at
  // 0.02–0.05, so those stay here.
  if (anchors.some((a) => a.matchType !== "fts")) return null;
  try {
    const response = await (params.evaluator ?? inProcessEvaluator)(
      {
        point: RECALL_POINT,
        state: {
          message: params.userMessage,
          recent: params.recentTail ?? null,
        },
        questions: {
          ...buildRelevanceQuestions(hits),
          ...buildAnchorSelectQuestions(anchors),
        },
        ...(params.conversationId !== undefined
          ? { sessionId: params.conversationId }
          : {}),
      },
      { teamId: params.teamId, organizationId: params.organizationId },
    );
    const kept = readRelevance(response, hits.length);
    const keptAnchors = readAnchorSelection(response, anchors.length);
    if (params.conversationId !== undefined) {
      // Not awaited: the person is waiting on this turn, and a lost journal
      // row costs one calibration sample, never an answer.
      void recordDecisions(
        relevanceJournalEntries({
          organizationId: params.organizationId,
          teamId: params.teamId,
          conversationId: params.conversationId,
          turnKey: crypto.randomUUID(),
          hits,
          response,
          kept,
        }),
      ).catch((error: unknown) => {
        console.warn(
          "[recall] decision journal write failed:",
          error instanceof Error ? error.message : error,
        );
      });
    }
    if (kept === null || keptAnchors === null) return null;
    return buildVerbatimBlock(keepOnly(params.gathered, kept, keptAnchors));
  } catch (error) {
    console.warn(
      "[recall] decision select failed, handing the turn to the judge:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
