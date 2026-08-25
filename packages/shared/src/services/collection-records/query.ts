import { and, desc, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { CollectionRecordWithData } from "../../db/schema";
import { collectionRecords } from "../../db/schema";
import {
  SAFE_IDENT,
  qualifiedCollectionTable,
} from "../collection-schema/identifiers";
import { readRecordDataBatch } from "../collection-schema/record-io";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";

/**
 * Equality-filter a type's confirmed records by typed attribute values. A
 * minimal helper for internal callers — full-text search lives in
 * `listCollectionRecords`. Each filter becomes an `EXISTS` on the type's extension
 * table (`e."key"::text = value`), comparing on the text form so any primitive
 * filter value works; the matched rows then get their `data` map batch-attached.
 *
 * Paginated with the shared convention (`page` zero-indexed, `limit`
 * default 25 / max-50-aligned, `offset = page * limit`).
 */
export const queryCollectionRecords = async (data: {
  teamId: string;
  collectionId: string;
  filters?: Record<string, unknown>;
  page?: number;
  limit?: number;
}): Promise<CollectionRecordWithData[]> => {
  const { teamId, collectionId, filters = {}, page = 0, limit = 25 } = data;
  const table = qualifiedCollectionTable(collectionId);

  const conditions = [
    eq(collectionRecords.teamId, teamId),
    eq(collectionRecords.collectionId, collectionId),
    eq(collectionRecords.status, "confirmed"),
  ];
  for (const [key, value] of Object.entries(filters)) {
    const text = toFilterText(value);
    if (text === null || !SAFE_IDENT.test(key)) continue;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} e WHERE e."id" = ${collectionRecords.id} AND e.${sql.raw(`"${key}"`)}::text = ${text})`,
    );
  }

  const rows = await db
    .select()
    .from(collectionRecords)
    .where(and(...conditions))
    .orderBy(desc(collectionRecords.createdAt))
    .limit(limit)
    .offset(Math.max(0, page * limit));
  if (rows.length === 0) return [];

  const fieldDefs = await getFieldDefinitionsForTeam({ teamId, collectionId });
  const dataById = await readRecordDataBatch({
    collectionId,
    recordIds: rows.map((r) => r.id),
    fields: fieldDefs,
  });
  return rows.map((r) => ({ ...r, data: dataById.get(r.id) ?? {} }));
};

/**
 * Coerce a filter value to the text form `data ->> key` projects to. Only
 * primitives are comparable that way; null / objects / arrays return null so
 * the caller skips them.
 */
const toFilterText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};
