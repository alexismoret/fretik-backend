import { and, desc, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { ObjectRecord } from "../../db/schema";
import { objectRecords } from "../../db/schema";

/**
 * Equality-filter a type's confirmed records by JSONB attribute values
 * (`data->>'key' = value`). A minimal helper for internal callers — full-text
 * search lives in `listObjectRecords`. Non-string filter values are compared
 * by their string form, matching the `->>'key'` text projection.
 *
 * Paginated with the shared convention (`page` zero-indexed, `limit`
 * default 25 / max-50-aligned, `offset = page * limit`) so a handler can pass
 * a parsed `paramsListSchema` query straight through.
 */
export const queryObjectRecords = async (data: {
  teamId: string;
  objectTypeId: string;
  filters?: Record<string, unknown>;
  page?: number;
  limit?: number;
}): Promise<ObjectRecord[]> => {
  const { teamId, objectTypeId, filters = {}, page = 0, limit = 25 } = data;

  const conditions = [
    eq(objectRecords.teamId, teamId),
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, "confirmed"),
  ];
  for (const [key, value] of Object.entries(filters)) {
    const text = toFilterText(value);
    if (text === null) continue;
    conditions.push(sql`${objectRecords.data} ->> ${key} = ${text}`);
  }

  return await db
    .select()
    .from(objectRecords)
    .where(and(...conditions))
    .orderBy(desc(objectRecords.createdAt))
    .limit(limit)
    .offset(Math.max(0, page * limit));
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
