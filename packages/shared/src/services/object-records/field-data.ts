import { and, count, eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions, objectRecords } from "../../db/schema";

/** Anti-injection guard, mirrored from sync-typed-view: keys are slug-validated
 * at write but the recompute composes them into SQL, so re-assert here. */
const SAFE_IDENT = /^[a-z][a-z0-9_]*$/;

/**
 * Field types that contribute to `search_vector` — must stay in lockstep with
 * `TEXT_LIKE_TYPES` in `schemas/record-shape.ts` (`computeRecordIdentity`), so a
 * background recompute produces the same vector the write path would.
 */
const TEXT_LIKE_TYPES: ReadonlySet<FieldDefinition["type"]> = new Set([
  "text",
  "url",
  "email",
  "select",
]);

/**
 * Maintain the per-field values stored inside records' `data` JSONB when a field
 * DEFINITION changes — the replacement for the old `document_field_values`
 * cascade. Field values now live on `object_records.data` (keyed by the field
 * key), so renaming/dropping a field definition has to rewrite the JSONB of
 * every record of that type.
 *
 * Scoped by `objectTypeId` (records of a type all share it), which is tighter
 * than the old global-by-`fieldKey` delete. JSONB keys are passed as bound text
 * parameters via `jsonb_exists`/`jsonb_extract_path` (function form, no operator
 * ambiguity, no injection). The denormalized `searchVector` is intentionally
 * NOT recomputed here — a catalog change schedules a bounded background recompute
 * (Phase 3), the same seam that refreshes typed views.
 */

/** Count a type's records whose `data` carries `key` (the "do values exist?" gate). */
export const countRecordsWithFieldKey = async (input: {
  tx?: Transaction;
  objectTypeId: string;
  key: string;
}): Promise<number> => {
  const exec = input.tx ?? db;
  const [row] = await exec
    .select({ n: count() })
    .from(objectRecords)
    .where(
      and(
        eq(objectRecords.objectTypeId, input.objectTypeId),
        sql`jsonb_exists(${objectRecords.data}, ${input.key})`,
      ),
    );
  return row?.n ?? 0;
};

/** Drop one or more field keys from every record's `data` for a type. Returns rows touched. */
export const deleteFieldKeysFromRecords = async (input: {
  tx?: Transaction;
  objectTypeId: string;
  keys: string[];
}): Promise<number> => {
  if (input.keys.length === 0) return 0;
  const exec = input.tx ?? db;
  const rows = await exec
    .update(objectRecords)
    .set({ data: sql`${objectRecords.data} - ${input.keys}::text[]` })
    .where(
      and(
        eq(objectRecords.objectTypeId, input.objectTypeId),
        sql`jsonb_exists_any(${objectRecords.data}, ${input.keys}::text[])`,
      ),
    )
    .returning({ id: objectRecords.id });
  return rows.length;
};

/** Rename a field key in every record's `data` for a type (value carried to the new key). */
export const renameFieldKeyInRecords = async (input: {
  tx?: Transaction;
  objectTypeId: string;
  fromKey: string;
  toKey: string;
}): Promise<number> => {
  if (input.fromKey === input.toKey) return 0;
  const exec = input.tx ?? db;
  const rows = await exec
    .update(objectRecords)
    .set({
      data: sql`(${objectRecords.data} - ${input.fromKey}::text) || jsonb_build_object(${input.toKey}::text, jsonb_extract_path(${objectRecords.data}, ${input.fromKey}))`,
    })
    .where(
      and(
        eq(objectRecords.objectTypeId, input.objectTypeId),
        sql`jsonb_exists(${objectRecords.data}, ${input.fromKey})`,
      ),
    )
    .returning({ id: objectRecords.id });
  return rows.length;
};

/**
 * Recompute `search_vector` for every record of a (team, type) after a CATALOG
 * change — a field added / removed / retyped leaves the denormalized vector
 * stale (it was computed against the old text-field set). One set-based UPDATE
 * (not N round-trips), the remaining piece of the field-definition cascade.
 *
 * Reads the team's ENABLED field defs DIRECTLY (not the Redis cache): it runs at
 * catalog-change time and must see the post-change truth. The vector formula
 * mirrors `computeRecordIdentity`: `label` plus the text-like field values,
 * tokenized with the `simple` config — so it matches what the write path would
 * produce. Returns the number of records touched.
 */
export const recomputeSearchVectorsForType = async (input: {
  organizationId?: string;
  objectTypeId: string;
  teamId: string;
  tx?: Transaction;
}): Promise<number> => {
  const exec = input.tx ?? db;

  const defs = await exec
    .select({
      key: fieldDefinitions.key,
      type: fieldDefinitions.type,
    })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, input.teamId),
        eq(fieldDefinitions.objectTypeId, input.objectTypeId),
        eq(fieldDefinitions.enabled, true),
      ),
    );

  // `coalesce(label,'') || ' ' || coalesce(data->>'k1','') || …` — the same
  // text the write path joins, embedded with slug-validated keys (injection-safe).
  let textExpr = "coalesce(label, '')";
  for (const def of defs) {
    if (!TEXT_LIKE_TYPES.has(def.type)) continue;
    if (!SAFE_IDENT.test(def.key)) continue;
    textExpr += ` || ' ' || coalesce(data->>'${def.key}', '')`;
  }

  const rows = await exec
    .update(objectRecords)
    .set({ searchVector: sql`to_tsvector('simple', ${sql.raw(textExpr)})` })
    .where(
      and(
        eq(objectRecords.objectTypeId, input.objectTypeId),
        eq(objectRecords.teamId, input.teamId),
      ),
    )
    .returning({ id: objectRecords.id });
  return rows.length;
};
