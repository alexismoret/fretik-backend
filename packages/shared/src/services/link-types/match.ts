import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import db from "../../db";
import { collections, linkTypes } from "../../db/schema";
import { FUZZY_MATCH_THRESHOLD } from "../../lib/resolution";
import type { DecisionResponse } from "../../schemas/decisions";
import { recordDecisions } from "../decisions/journal";
import type { DecisionEvaluator } from "../decisions/remote";
import { createLinkType } from "./create";
import {
  buildLinkTypeQuestion,
  LINK_TYPE_POINT,
  linkTypeJournalEntry,
  linkTypeQuestionId,
  MAX_LINK_TYPE_CANDIDATES,
  readLinkTypeVerdict,
} from "./match-by-meaning";

type ResolveLinkTypeResult = {
  linkTypeId: string;
  isNew: boolean;
};

const slugifyLinkTypeKey = (raw: string): string =>
  raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

/**
 * Canonicalize a proposed relation against existing link types to prevent
 * predicate sprawl (`works_for` vs `employed_by`). Within the double-arm scope
 * (team + org/system) and the same `fromCollectionId`:
 *   1. exact `normalizedKey` match
 *   2. trigram similarity on `normalizedKey` >= FUZZY_MATCH_THRESHOLD (best
 *      match; deliberately strict — precision-first)
 *
 * On no match, creates a `suggested` link type. Returns the resolved id and
 * whether it is new. (Embedding-based matching is future work; the slug +
 * trigram pass is sufficient now.)
 */
export const resolveLinkType = async (data: {
  organizationId: string;
  teamId: string;
  rawKey: string;
  fromCollectionId: string;
  toCollectionId?: string | null;
  /**
   * Opt-in stage 3: ask the decision model whether the name MEANS an
   * existing type (`match-by-meaning.ts`). Opt-in because it is a network
   * call, and the record-creation path resolves relations while a caller's
   * transaction may be open; only callers that hold none pass one.
   */
  byMeaning?: DecisionEvaluator;
}): Promise<ResolveLinkTypeResult> => {
  const { organizationId, teamId, rawKey, fromCollectionId, toCollectionId } =
    data;
  const normalizedKey = slugifyLinkTypeKey(rawKey);

  const scope = and(
    eq(linkTypes.fromCollectionId, fromCollectionId),
    or(
      eq(linkTypes.teamId, teamId),
      and(
        isNull(linkTypes.teamId),
        eq(linkTypes.organizationId, organizationId),
      ),
    ),
  );

  // Stage 1: exact normalized key.
  const [exact] = await db
    .select({ id: linkTypes.id })
    .from(linkTypes)
    .where(and(scope, eq(linkTypes.normalizedKey, normalizedKey)))
    .limit(1);
  if (exact) {
    return { linkTypeId: exact.id, isNew: false };
  }

  // Stage 2: trigram similarity on the normalized key.
  const sim = sql<number>`similarity(${linkTypes.normalizedKey}, ${normalizedKey})`;
  const [trigramMatch] = await db
    .select({ id: linkTypes.id, sim: sim.as("sim") })
    .from(linkTypes)
    .where(and(scope, gte(sim, FUZZY_MATCH_THRESHOLD)))
    .orderBy(desc(sim))
    .limit(1);
  if (trigramMatch) {
    return { linkTypeId: trigramMatch.id, isNew: false };
  }

  // Stage 3 (opt-in): by meaning.
  const meaning = data.byMeaning
    ? await matchByMeaning({
        evaluator: data.byMeaning,
        organizationId,
        teamId,
        rawKey,
        normalizedKey,
        fromCollectionId,
        toCollectionId: toCollectionId ?? null,
        scope,
      })
    : null;
  if (meaning?.reuseId) {
    await recordDecisions([
      linkTypeJournalEntry({
        organizationId,
        teamId,
        fromCollectionId,
        questionId: meaning.questionId,
        response: meaning.response,
        chosenId: meaning.chosenId,
        reusedId: meaning.reuseId,
        legacyCreated: false,
      }),
    ]);
    return { linkTypeId: meaning.reuseId, isNew: false };
  }

  const created = await createLinkType({
    organizationId,
    teamId,
    key: rawKey,
    label: rawKey,
    fromCollectionId,
    toCollectionId: toCollectionId ?? null,
    status: "suggested",
    source: "ai_extraction",
  });
  // Journaled after the create, so a verdict that did not reuse sits next to
  // what happened instead: a new type. The new type is the row a reviewer
  // opens to see which existing one the model leaned to.
  if (meaning) {
    await recordDecisions([
      linkTypeJournalEntry({
        organizationId,
        teamId,
        fromCollectionId,
        questionId: meaning.questionId,
        response: meaning.response,
        chosenId: meaning.chosenId,
        reusedId: null,
        legacyCreated: true,
      }),
    ]);
  }
  return { linkTypeId: created.id, isNew: true };
};

/**
 * Ask whether `rawKey` means one of the relation types in scope. Null when
 * there is nothing to compare against.
 */
const matchByMeaning = async (params: {
  evaluator: DecisionEvaluator;
  organizationId: string;
  teamId: string;
  rawKey: string;
  normalizedKey: string;
  fromCollectionId: string;
  toCollectionId: string | null;
  scope: SQL | undefined;
}): Promise<{
  questionId: string;
  response: DecisionResponse | null;
  reuseId: string | null;
  chosenId: string | null;
} | null> => {
  const candidates = await db
    .select({
      id: linkTypes.id,
      label: linkTypes.label,
      inverseLabel: linkTypes.inverseLabel,
    })
    .from(linkTypes)
    .where(params.scope)
    .orderBy(desc(linkTypes.createdAt))
    .limit(MAX_LINK_TYPE_CANDIDATES);
  if (candidates.length === 0) return null;

  const collectionIds = [params.fromCollectionId, params.toCollectionId].filter(
    (id): id is string => id !== null,
  );
  const labels = new Map(
    (
      await db
        .select({ id: collections.id, label: collections.label })
        .from(collections)
        .where(inArray(collections.id, collectionIds))
    ).map((c) => [c.id, c.label]),
  );

  const questionId = linkTypeQuestionId(params.normalizedKey);
  const response = await params.evaluator(
    {
      point: LINK_TYPE_POINT,
      subject: { type: "collection", id: params.fromCollectionId },
      state: {
        relation: params.rawKey,
        from: labels.get(params.fromCollectionId) ?? null,
        to:
          params.toCollectionId === null
            ? null
            : (labels.get(params.toCollectionId) ?? null),
      },
      questions: {
        [questionId]: buildLinkTypeQuestion(params.rawKey, candidates),
      },
    },
    { teamId: params.teamId, organizationId: params.organizationId },
  );
  const verdict = readLinkTypeVerdict(response, questionId, candidates);
  return {
    questionId,
    response,
    reuseId: verdict.reuseId,
    chosenId: verdict.chosenId,
  };
};

/**
 * Batch resolver of many relation keys against ONE source type. Reads the scope
 * once and serves exact `normalizedKey` matches in-memory, so the work scales
 * with the number of DISTINCT relations referenced (a type has a handful), never
 * with the number of rows referencing them. Only a genuinely new key falls back
 * to the single {@link resolveLinkType} (trigram canonicalization + create) —
 * bounded by new-relation count, never per-row. Returns Map(rawKey →
 * linkTypeId). Use this from the bulk record-with-relations path.
 */
export const resolveLinkTypes = async (data: {
  organizationId: string;
  teamId: string;
  fromCollectionId: string;
  rawKeys: string[];
}): Promise<Map<string, string>> => {
  const { organizationId, teamId, fromCollectionId } = data;
  const distinct = [...new Set(data.rawKeys)];
  const map = new Map<string, string>();
  if (distinct.length === 0) return map;

  const scopeRows = await db
    .select({ id: linkTypes.id, normalizedKey: linkTypes.normalizedKey })
    .from(linkTypes)
    .where(
      and(
        eq(linkTypes.fromCollectionId, fromCollectionId),
        or(
          eq(linkTypes.teamId, teamId),
          and(
            isNull(linkTypes.teamId),
            eq(linkTypes.organizationId, organizationId),
          ),
        ),
      ),
    );
  const byNormalized = new Map(scopeRows.map((r) => [r.normalizedKey, r.id]));

  for (const rawKey of distinct) {
    const normalized = slugifyLinkTypeKey(rawKey);
    const exact = byNormalized.get(normalized);
    if (exact) {
      map.set(rawKey, exact);
      continue;
    }
    const { linkTypeId } = await resolveLinkType({
      organizationId,
      teamId,
      rawKey,
      fromCollectionId,
    });
    map.set(rawKey, linkTypeId);
    byNormalized.set(normalized, linkTypeId);
  }
  return map;
};
