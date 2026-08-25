import { and, arrayContains, desc, eq, gte, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { NewCollectionRecord } from "../../db/schema";
import { collectionRecords } from "../../db/schema";
import { internalError, notFound, throwHttpError } from "../../lib/errors";
import { FUZZY_MATCH_THRESHOLD } from "../../lib/resolution";
import { normalizeEntityName } from "../../utils/normalizeEntityName";
import { buildExtensionInsert } from "../collection-schema/record-io";

type ResolveResult = {
  /** null only when nothing matched and `createIfMissing` was false. */
  recordId: string | null;
  confidence: number;
  isNew: boolean;
};

/**
 * Resolve a raw label to an existing confirmed record of a given type, or
 * create a `suggested` one. Generalizes the entity-matching cascade scoped to
 * `(teamId, collectionId, status='confirmed')`:
 *   1. exact `normalizedLabel`
 *   2. alias array contains the normalized label
 *   3. trigram similarity on `normalizedLabel` >= FUZZY_MATCH_THRESHOLD (best
 *      match; deliberately strict — precision-first, prefer a suggested record
 *      over a false-positive merge)
 *
 * Pre-existing `rejected` / `suggested` rows with the same normalized label
 * are returned as-is (never duplicated, never silently re-created).
 *
 * `createIfMissing` (default true): when false, an unmatched label returns
 * `{ recordId: null }` instead of spawning a `suggested` stub — the caller gates
 * creation (e.g. a low-confidence mention still links to an existing record but
 * must not create a new one).
 *
 * Pass `tx` to resolve inside a caller's transaction (the document-processing
 * fold): the dedup reads then see suggested records created earlier in the same
 * transaction, so two extracted mentions of the same name collapse to one stub.
 */
export const resolveRecord = async (data: {
  teamId: string;
  collectionId: string;
  rawLabel: string;
  createIfMissing?: boolean;
  tx?: Transaction;
}): Promise<ResolveResult> => {
  const { teamId, collectionId, rawLabel, tx } = data;
  const createIfMissing = data.createIfMissing ?? true;
  const exec = tx ?? db;
  const normalized =
    normalizeEntityName(rawLabel) || rawLabel.toLowerCase().trim();

  // Stage 1: exact normalized label (confirmed only).
  const exact = await exec.query.collectionRecords.findFirst({
    columns: { id: true },
    where: {
      teamId,
      collectionId,
      normalizedLabel: normalized,
      status: "confirmed",
    },
  });
  if (exact) {
    return { recordId: exact.id, confidence: 1.0, isNew: false };
  }

  // Stage 2: alias array match (confirmed only).
  const [aliasMatch] = await exec
    .select({ id: collectionRecords.id })
    .from(collectionRecords)
    .where(
      and(
        eq(collectionRecords.teamId, teamId),
        eq(collectionRecords.collectionId, collectionId),
        eq(collectionRecords.status, "confirmed"),
        arrayContains(collectionRecords.aliases, [normalized]),
      ),
    )
    .limit(1);
  if (aliasMatch) {
    return { recordId: aliasMatch.id, confidence: 1.0, isNew: false };
  }

  // Stage 3: trigram similarity on the normalized label (confirmed only).
  const sim = sql<number>`similarity(${collectionRecords.normalizedLabel}, ${normalized})`;
  const [trigramMatch] = await exec
    .select({ id: collectionRecords.id, sim: sim.as("sim") })
    .from(collectionRecords)
    .where(
      and(
        eq(collectionRecords.teamId, teamId),
        eq(collectionRecords.collectionId, collectionId),
        eq(collectionRecords.status, "confirmed"),
        gte(sim, FUZZY_MATCH_THRESHOLD),
      ),
    )
    .orderBy(desc(sim))
    .limit(1);
  if (trigramMatch) {
    return {
      recordId: trigramMatch.id,
      confidence: trigramMatch.sim,
      isNew: false,
    };
  }

  // Respect an existing rejected or suggested row — do not duplicate.
  const existing = await exec.query.collectionRecords.findFirst({
    columns: { id: true },
    where: {
      teamId,
      collectionId,
      normalizedLabel: normalized,
      status: { in: ["rejected", "suggested"] },
    },
  });
  if (existing) {
    return { recordId: existing.id, confidence: 0, isNew: false };
  }

  // Nothing matched. Gate creation to the caller (confidence floor, dry-run).
  if (!createIfMissing) {
    return { recordId: null, confidence: 0, isNew: false };
  }

  return await createSuggestedRecord({
    teamId,
    collectionId,
    rawLabel,
    normalized,
    tx,
  });
};

/**
 * Create a `suggested` record from an AI extraction. The organization id is
 * read from the collection (records carry it NOT NULL).
 */
const createSuggestedRecord = async (data: {
  teamId: string;
  collectionId: string;
  rawLabel: string;
  normalized: string;
  tx?: Transaction;
}): Promise<ResolveResult> => {
  const exec = data.tx ?? db;
  const collection = await exec.query.collections.findFirst({
    columns: { organizationId: true },
    where: { id: data.collectionId },
  });
  if (!collection) {
    return throwHttpError(404, notFound("Collection not found"));
  }

  const newRecord: NewCollectionRecord = {
    organizationId: collection.organizationId,
    teamId: data.teamId,
    collectionId: data.collectionId,
    status: "suggested",
    source: "ai_extraction",
    label: data.rawLabel,
    normalizedLabel: data.normalized,
    aliases: [],
  };

  const [row] = await exec
    .insert(collectionRecords)
    .values(newRecord)
    .returning({ id: collectionRecords.id });
  if (!row) {
    return throwHttpError(500, internalError());
  }

  // The suggested stub still needs its (empty) typed extension row so the id FK
  // holds and later reads/updates target a real row.
  await exec.execute(
    buildExtensionInsert({
      collectionId: data.collectionId,
      recordId: row.id,
      teamId: data.teamId,
      label: data.rawLabel,
      status: "suggested",
      fields: [],
      data: {},
    }),
  );
  return { recordId: row.id, confidence: 0, isNew: true };
};
