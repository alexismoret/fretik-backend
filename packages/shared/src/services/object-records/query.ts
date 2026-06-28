import { and, desc, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { ObjectRecordWithData } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { SAFE_IDENT, qualifiedObjectTable } from "../object-schema/identifiers";
import { readRecordDataBatch } from "../object-schema/record-io";

/**
 * Equality-filter a type's confirmed records by typed attribute values. A
 * minimal helper for internal callers — full-text search lives in
 * `listObjectRecords`. Each filter becomes an `EXISTS` on the type's extension
 * table (`e."key"::text = value`), comparing on the text form so any primitive
 * filter value works; the matched rows then get their `data` map batch-attached.
 *
 * Paginated with the shared convention (`page` zero-indexed, `limit`
 * default 25 / max-50-aligned, `offset = page * limit`).
 */
export const queryObjectRecords = async (data: {
  teamId: string;
  objectTypeId: string;
  filters?: Record<string, unknown>;
  page?: number;
  limit?: number;
}): Promise<ObjectRecordWithData[]> => {
  const { teamId, objectTypeId, filters = {}, page = 0, limit = 25 } = data;
  const table = qualifiedObjectTable(objectTypeId);

  const conditions = [
    eq(objectRecords.teamId, teamId),
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, "confirmed"),
  ];
  for (const [key, value] of Object.entries(filters)) {
    const text = toFilterText(value);
    if (text === null || !SAFE_IDENT.test(key)) continue;
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} e WHERE e."id" = ${objectRecords.id} AND e.${sql.raw(`"${key}"`)}::text = ${text})`,
    );
  }

  const rows = await db
    .select()
    .from(objectRecords)
    .where(and(...conditions))
    .orderBy(desc(objectRecords.createdAt))
    .limit(limit)
    .offset(Math.max(0, page * limit));
  if (rows.length === 0) return [];

  const fieldDefs = await getFieldDefinitionsForTeam({ teamId, objectTypeId });
  const dataById = await readRecordDataBatch({
    objectTypeId,
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
