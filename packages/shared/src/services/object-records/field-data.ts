import { and, eq, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { columnsForField } from "../object-schema/columns";
import {
  assertSafeKey,
  qualifiedObjectTable,
  SAFE_IDENT,
} from "../object-schema/identifiers";

/**
 * Field-data maintenance after a CATALOG change. Field values now live in real
 * typed columns on the per-type extension table (`data.obj_<typeId>`), so adding
 * / removing / retyping a field is `ALTER TABLE` (the DDL engine), not a JSONB
 * rewrite. What remains here:
 *   - `countNonNullColumnValues` — the "do values exist?" gate (replaces the old
 *     `jsonb_exists` count) used before a destructive field change.
 *   - `recomputeSearchVectorsForType` — refresh the registry's `search_vector`
 *     from the type's text-like columns after a catalog change.
 */

/**
 * Field types whose values feed `search_vector` — the genuinely textual ones.
 * Excludes numeric/date/boolean/money/member/rating (filtered, not searched) and
 * relation/rollup (virtual). MUST stay in lockstep with the same set in
 * `schemas/record-shape.ts` so a background recompute matches the write path.
 */
const TEXT_LIKE_TYPES: ReadonlySet<FieldDefinition["type"]> = new Set([
  "text",
  "markdown",
  "url",
  "email",
  "phone",
  "select",
  "multi_select",
]);

/**
 * How many records of a type carry a non-NULL value for a field — the gate that
 * blocks a destructive field change (key/type) unless `cascade`. `money` checks
 * its `<key>_amount` column; virtual fields (relation/rollup) have no column and
 * always return 0.
 */
export const countNonNullColumnValues = async (input: {
  objectTypeId: string;
  field: FieldDefinition;
  tx?: Executor;
}): Promise<number> => {
  const cols = columnsForField(input.field);
  const col = cols[0]?.name;
  if (!col) return 0;
  const exec = input.tx ?? db;
  const res = await exec.execute(
    sql`SELECT count(*)::int AS n
        FROM ${sql.raw(qualifiedObjectTable(input.objectTypeId))} e
        WHERE e.${sql.raw(`"${col}"`)} IS NOT NULL`,
  );
  const n = res.rows[0]?.n;
  return typeof n === "number" ? n : 0;
};

/** The SQL text for one text-like field column (arrays are flattened). */
const fieldTextExpr = (key: string, type: FieldDefinition["type"]): string =>
  type === "multi_select"
    ? `coalesce(array_to_string(e."${key}", ' '), '')`
    : `coalesce(e."${key}"::text, '')`;

/**
 * Recompute `search_vector` for every record of a (team, type) after a catalog
 * change — a field added / removed / retyped leaves the denormalized vector
 * stale. One set-based UPDATE joining the typed extension table. The vector
 * formula mirrors `computeRecordIdentity`: `label` plus the text-like field
 * values, tokenized with the `simple` config. Returns rows touched.
 */
export const recomputeSearchVectorsForType = async (input: {
  organizationId?: string;
  objectTypeId: string;
  teamId: string;
  tx?: Executor;
}): Promise<number> => {
  const exec = input.tx ?? db;

  const defs = await exec
    .select({ key: fieldDefinitions.key, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, input.teamId),
        eq(fieldDefinitions.objectTypeId, input.objectTypeId),
        eq(fieldDefinitions.enabled, true),
      ),
    );

  const table = qualifiedObjectTable(input.objectTypeId);
  // `coalesce(r.label,'') || ' ' || <text-like field exprs>` — slug-validated
  // keys, injection-safe. With no text fields, the label alone seeds the vector.
  let textExpr = "coalesce(r.label, '')";
  for (const { key, type } of defs) {
    if (!TEXT_LIKE_TYPES.has(type) || !SAFE_IDENT.test(key)) continue;
    assertSafeKey(key, "field key");
    textExpr += ` || ' ' || ${fieldTextExpr(key, type)}`;
  }

  const res = await exec.execute(
    sql`UPDATE object_records r
        SET search_vector = to_tsvector('simple', ${sql.raw(textExpr)})
        FROM ${sql.raw(table)} e
        WHERE e.id = r.id
          AND r.object_type_id = ${input.objectTypeId}::uuid
          AND r.team_id = ${input.teamId}::uuid`,
  );
  return res.rowCount ?? 0;
};
