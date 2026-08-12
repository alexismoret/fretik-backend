import db from "@fretik/shared/db";
import { objectRecords, objectTypes } from "@fretik/shared/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * The third retrieval arm: lexical search over the RECORD REGISTRY, not over
 * `ai_vectors`.
 *
 * Why it exists. The other two arms both read `ai_vectors`, so both are blind
 * to whatever was never embedded — and the card-indexing policy
 * (`card-indexing-policy.ts`) deliberately stops embedding a type past
 * `CARD_INDEX_ROW_CEILING`. Without this arm that ceiling would not be a cost
 * decision, it would be a blind spot: import 200 000 clients and the assistant
 * stops being able to find any of them by name. This is the piece that makes
 * the ceiling affordable.
 *
 * Why it costs nothing. `object_records.search_vector` is an EXISTING
 * GIN-indexed tsvector over label + the type's text fields, maintained by the
 * write path on every insert and update INCLUDING bulk — no embedding call, no
 * second corpus to keep in sync, complete at any volume. The arm is a `@@`
 * probe against an index that is already there.
 *
 * What it does NOT read: the typed extension table. Matching is rich (the
 * search vector already folds in the type's text fields), display is cheap
 * (label + type + aliases, which is what a name-shaped query matched on). The
 * per-field detail is exactly what the semantic card exists for below the
 * ceiling; paying a per-record extension read here would reintroduce the
 * per-row cost the ceiling removes.
 *
 * Scope is `team_id = :teamId`, deliberately the same as the vector arms and
 * no wider: a record card is written with the OWNING team's id, so a record
 * shared cross-team is already invisible to `searchKnowledge` today. Matching
 * that exactly keeps the three arms consistent — widening here would surface
 * through one arm what the other two hide.
 */

export interface RegistryRow {
  recordId: string;
  label: string;
  aliases: string[];
  objectTypeId: string;
  typeKey: string;
  typeLabel: string;
  createdAt: Date;
}

export const runRecordRegistrySearch = async (input: {
  queryText: string;
  teamId: string;
  organizationId: string;
  /** Restrict to specific record ids — the `sourceIds` filter, applied here. */
  recordIds?: string[];
  limit: number;
}): Promise<RegistryRow[]> => {
  // `'simple'` matches the tokeniser `object_records.search_vector` is built
  // with, exactly as the BM25 arm matches `ai_vectors.search_vector` — any
  // other regconfig builds a different lexeme set and the GIN index is skipped.
  const tsquery = sql`plainto_tsquery('simple', ${input.queryText})`;

  const clauses = [
    eq(objectRecords.teamId, input.teamId),
    eq(objectRecords.organizationId, input.organizationId),
    eq(objectRecords.status, "confirmed"),
    // Document mirrors are already indexed as `source_type='documents'` with
    // their full content — the same exclusion `buildRecordCard` applies, for
    // the same reason: one document must not occupy two slots in one sweep.
    isNull(objectRecords.documentId),
    sql`${objectRecords.searchVector} @@ ${tsquery}`,
  ];
  if (input.recordIds && input.recordIds.length > 0) {
    clauses.push(inArray(objectRecords.id, input.recordIds));
  }

  return db
    .select({
      recordId: objectRecords.id,
      label: objectRecords.label,
      aliases: objectRecords.aliases,
      objectTypeId: objectRecords.objectTypeId,
      typeKey: objectTypes.key,
      typeLabel: objectTypes.label,
      createdAt: objectRecords.createdAt,
    })
    .from(objectRecords)
    .innerJoin(objectTypes, eq(objectTypes.id, objectRecords.objectTypeId))
    .where(and(...clauses))
    .orderBy(sql`ts_rank_cd(${objectRecords.searchVector}, ${tsquery}) DESC`)
    .limit(input.limit);
};
