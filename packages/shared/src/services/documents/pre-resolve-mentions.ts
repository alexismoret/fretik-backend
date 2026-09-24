import { and, arrayContains, desc, eq, gte, or, sql } from "drizzle-orm";
import db from "../../db";
import { collectionRecords } from "../../db/schema";
import { chosenOf, minChosenFor, thresholdFor } from "../../decisions/policy";
import { FUZZY_MATCH_THRESHOLD } from "../../lib/resolution";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "../../schemas/decisions";
import { normalizeEntityName } from "../../utils/normalizeEntityName";
import { resolveCollectionId } from "../collections/resolve";
import { recordDecisions, type JournalEntry } from "../decisions/journal";
import { answerJournalEntry } from "../decisions/journal-entry";
import { remoteEvaluator, type DecisionEvaluator } from "../decisions/remote";
import { resolveMentionTargetCollectionKey } from "./sync-document-graph";

/**
 * The parties a document mentions, matched to existing records by MEANING
 * where spelling cannot decide — before the processing transaction opens.
 *
 * The graph fold links a mention by exact name, alias, or a trigram
 * similarity of 0.8, and creates a suggested record for everything else. So
 * "Northwind" and "Northwind Traders Ltd" (similarity well under 0.8) become
 * two companies, and every later answer about the client is split between
 * them. For a mention whose nearest records sit between 0.45 and 0.8, the
 * decision model is shown the candidates and the document, and picks one or
 * "another one". A confident pick becomes a hint the fold uses as-is.
 *
 * Runs OUTSIDE the transaction by design: it is a network call, and the fold
 * holds a Postgres transaction that must never wait on one.
 */

export const ENTITY_POINT = "graph.entity-match";
export const NEW_ENTITY_OPTION = "__new__";

/** Below this, a record is not a plausible candidate at all. */
const NEAR_MIN_SIMILARITY = 0.45;
const MAX_CANDIDATES = 5;
/** Mentions asked about per document; the rest go to the fold unchanged. */
const MAX_MENTIONS = 12;

export interface EntityCandidate {
  id: string;
  label: string;
}

/** The key a mention and its hint are matched on, the fold's normalization. */
export const mentionKey = (name: string): string =>
  normalizeEntityName(name) || name.toLowerCase().trim();

export const entityQuestionId = (index: number): string =>
  `ent:${index.toString()}`;

export const buildEntityQuestion = (
  mention: string,
  candidates: readonly EntityCandidate[],
): DecisionQuestion => {
  const criteria: Record<string, string> = {
    [NEW_ENTITY_OPTION]:
      "Another party than all of these, or it cannot be told from the document.",
  };
  for (const c of candidates) criteria[c.id] = c.label;
  return {
    type: "choice",
    instructions: `The document mentions "${mention}". Which of these existing records is that party, if any?`,
    criteria,
  };
};

/** The record to link, or null to leave the mention to the fold. */
export const readEntityVerdict = (
  response: DecisionResponse | null,
  questionId: string,
  candidates: readonly EntityCandidate[],
): { linkId: string | null; chosenId: string | null } => {
  if (response?.status !== "answered") {
    return { linkId: null, chosenId: null };
  }
  const chosen = chosenOf(response.answers[questionId]);
  const chosenId =
    chosen && candidates.some((c) => c.id === chosen.choice)
      ? chosen.choice
      : null;
  const bar = thresholdFor(response.policy, questionId) ?? 1;
  const minChosen = minChosenFor(response.policy, questionId) ?? 0;
  const sure =
    chosen !== null &&
    chosen.confidence !== null &&
    chosen.confidence >= bar &&
    (chosen.probability ?? 0) >= minChosen;
  return { linkId: chosenId !== null && sure ? chosenId : null, chosenId };
};

/**
 * The nearest confirmed records of the target collection, or null when the
 * fold will match this mention on its own (exact, alias, or 0.8 similarity)
 * and nothing needs asking.
 */
const nearCandidates = async (params: {
  teamId: string;
  collectionId: string;
  key: string;
}): Promise<EntityCandidate[] | null> => {
  const sim = sql<number>`similarity(${collectionRecords.normalizedLabel}, ${params.key})`;
  const rows = await db
    .select({
      id: collectionRecords.id,
      label: collectionRecords.label,
      normalizedLabel: collectionRecords.normalizedLabel,
      sim: sim.as("sim"),
      alias: sql<boolean>`${collectionRecords.aliases} @> ARRAY[${params.key}]::text[]`,
    })
    .from(collectionRecords)
    .where(
      and(
        eq(collectionRecords.teamId, params.teamId),
        eq(collectionRecords.collectionId, params.collectionId),
        eq(collectionRecords.status, "confirmed"),
        or(
          gte(sim, NEAR_MIN_SIMILARITY),
          arrayContains(collectionRecords.aliases, [params.key]),
        ),
      ),
    )
    .orderBy(desc(sim))
    .limit(MAX_CANDIDATES);
  if (rows.length === 0) return [];
  const settled = rows.some(
    (r) =>
      r.normalizedLabel === params.key ||
      r.alias ||
      r.sim >= FUZZY_MATCH_THRESHOLD,
  );
  return settled ? null : rows.map((r) => ({ id: r.id, label: r.label }));
};

/**
 * Hints for the fold: mention key → existing record id. Empty on no answer,
 * on an unsure one, or when nothing needed asking. Never throws; a failure leaves
 * every mention to the fold, exactly as before this pass existed.
 */
export const preResolveMentions = async (params: {
  organizationId: string;
  teamId: string;
  documentId: string;
  mentions: readonly { name: string }[];
  context: { filename: string; documentSummary: string | null };
  evaluator?: DecisionEvaluator;
}): Promise<Map<string, string>> => {
  const hints = new Map<string, string>();
  try {
    const keys = [
      ...new Set(
        params.mentions.map((m) => m.name.trim()).filter((n) => n.length > 0),
      ),
    ].slice(0, MAX_MENTIONS);
    if (keys.length === 0) return hints;

    const collectionId = await resolveCollectionId({
      organizationId: params.organizationId,
      teamId: params.teamId,
      key: await resolveMentionTargetCollectionKey(params.organizationId),
    });
    if (!collectionId) return hints;

    const asked: {
      name: string;
      key: string;
      candidates: EntityCandidate[];
    }[] = [];
    for (const name of keys) {
      const key = mentionKey(name);
      // eslint-disable-next-line no-await-in-loop
      const candidates = await nearCandidates({
        teamId: params.teamId,
        collectionId,
        key,
      });
      if (candidates && candidates.length > 0) {
        asked.push({ name, key, candidates });
      }
    }
    if (asked.length === 0) return hints;

    const response = await (params.evaluator ?? remoteEvaluator)(
      {
        point: ENTITY_POINT,
        subject: { type: "document", id: params.documentId },
        sessionId: `documents:${params.documentId}`,
        state: {
          filename: params.context.filename,
          documentSummary: params.context.documentSummary,
        },
        questions: Object.fromEntries(
          asked.map((a, i) => [
            entityQuestionId(i),
            buildEntityQuestion(a.name, a.candidates),
          ]),
        ),
      },
      { teamId: params.teamId, organizationId: params.organizationId },
    );

    const entries: JournalEntry[] = asked.map((a, i) => {
      const questionId = entityQuestionId(i);
      const verdict = readEntityVerdict(response, questionId, a.candidates);
      if (verdict.linkId !== null) hints.set(a.key, verdict.linkId);
      return answerJournalEntry({
        organizationId: params.organizationId,
        teamId: params.teamId,
        point: ENTITY_POINT,
        questionId,
        // Keyed by the name, so re-processing the document is the same row.
        journalQuestionId: `ent:${a.key}`,
        subjectType: "document",
        subjectId: params.documentId,
        targetId: verdict.chosenId,
        response,
        questionCount: asked.length,
        outcome: verdict.linkId !== null ? "linked" : "left",
        applied: verdict.linkId !== null,
      });
    });
    await recordDecisions(entries);
    return hints;
  } catch (error) {
    console.warn(
      `[entity-match] document ${params.documentId}: pre-pass failed, the fold decides alone:`,
      error instanceof Error ? error.message : error,
    );
    return new Map();
  }
};
