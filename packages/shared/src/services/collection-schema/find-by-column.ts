import { sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import type { FieldDefinitionType } from "../../db/schema/field-types";
import { chunkForBulk } from "../../lib/db-bulk";
import { columnsForField } from "./columns";
import { qualifiedCollectionTable, SYS_COL } from "./identifiers";
import { indexesTextPrefix, TEXT_INDEX_PREFIX } from "./indexes";

/**
 * Find records by the VALUE of one typed column.
 *
 * Nothing else reads the extension tables this way — `readRecordDataBatch` and
 * its siblings all address records by id, because until now every caller
 * already knew which records it wanted. A walked `columns` source does not: it
 * holds a page of the app's rows and has to ask which of OUR records each one
 * belongs to. That question is one indexed `= ANY` per page, and it is the
 * whole reason such a source costs a call per page instead of one per record.
 *
 * Identifier discipline is `record-io`'s: the table name comes from
 * `qualifiedCollectionTable`, the column from `columnsForField` (which
 * re-validates the key against `SAFE_IDENT`), and only those two are
 * interpolated. Every value is a bound parameter.
 */

/**
 * Field types whose column can key a match.
 *
 * The exclusions are not squeamishness, they are storage facts (see
 * `columnsForField`): `money` is TWO columns, so there is no single value to
 * compare; `date` is a `timestamptz` whose wire format the app decides, and a
 * match that silently depends on a timezone is worse than no match; arrays
 * (`multi_select`, multi `member`) are indexed by GIN, which has no equality
 * operator to offer; `location` is a foreign key into another table; `boolean`
 * cannot identify anything. Virtual types have no column at all.
 *
 * What is left is what people actually key on: a code, a reference, a SIRET,
 * an email, a number.
 */
export const MATCHABLE_FIELD_TYPES: ReadonlySet<FieldDefinitionType> = new Set([
  "text",
  "select",
  "url",
  "email",
  "phone",
  "number",
  "unique_id",
]);

export const isMatchableField = (
  field: Pick<FieldDefinition, "type" | "enabled">,
): boolean => field.enabled && MATCHABLE_FIELD_TYPES.has(field.type);

/**
 * The canonical string of a value on EITHER side of a match, or `undefined`
 * when it cannot key at all.
 *
 * Both sides go through this, which is the point: the app sends `"007"` in
 * JSON and Postgres holds `7` in a `numeric`, and those are the same invoice.
 * Comparing them as they arrive would silently match nothing — a run that
 * succeeds, calls everything unmatched, and fills no column.
 *
 * Text is compared EXACTLY, case included. Lower-casing would be a guess about
 * somebody else's key space, and a guess that merges two distinct references
 * is worse than a miss the preview shows you.
 */
export const matchKeyOf = (
  field: Pick<FieldDefinition, "type">,
  value: unknown,
): string | undefined => {
  if (value === null || value === undefined) return undefined;

  if (field.type === "number") {
    const asNumber = typeof value === "number" ? value : Number(value);
    // `String(Number(v))` is exact below 2^53 and canonicalises both
    // directions: "007" → "7", 7.50 → "7.5". Above that a JS double cannot
    // hold the value and two distinct keys could collapse into one — which is
    // why a long identifier belongs in a `text` or `unique_id` column, and why
    // the form says so where the column is picked.
    return Number.isFinite(asNumber) ? String(asNumber) : undefined;
  }
  if (field.type === "unique_id") {
    // A counter arrives as a string (the driver hands `bigint` back as one) or
    // as a number. Anything else cannot be an identifier, and stringifying it
    // would turn an object into the key `"[object Object]"` — which every row
    // carrying one would then share.
    const asString =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : undefined;
    if (asString === undefined) return undefined;
    return /^-?\d+$/.test(asString) ? BigInt(asString).toString() : undefined;
  }

  // The text family. A number is accepted and stringified, because an app that
  // sends `{"code": 4021}` for a column holding `"4021"` means the same row —
  // the same latitude `projectRow` already takes when it writes one.
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Keys per `= ANY`. The whole list rides as ONE bound array parameter, so the
 * 65535-parameter ceiling is not what bounds this — plan quality is. It mirrors
 * `SYNC_LIMITS.walkPageWriteChunk`, so a page of the app's list resolves in the
 * same number of round trips it is written in.
 */
const MATCH_CHUNK = 500;

/** The one physical column a matchable field maps to. */
const columnOf = (
  field: FieldDefinition,
): { name: string; sqlType: string } => {
  const [column] = columnsForField(field);
  if (column === undefined) {
    throw new Error(
      `field '${field.key}' has no physical column, so it cannot match rows`,
    );
  }
  return column;
};

/**
 * `matchKeyOf` value → the ids of this team's records holding it.
 *
 * A LIST per key, not one id: two records may legitimately carry the same
 * reference, and both should receive the app's answer. Silently keeping the
 * first would leave one of them stale forever with nothing to show for it.
 */
export const findRecordIdsByColumnValues = async (input: {
  collectionId: string;
  teamId: string;
  field: FieldDefinition;
  keys: readonly string[];
}): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>();
  if (input.keys.length === 0) return found;

  const column = columnOf(input.field);
  const table = qualifiedCollectionTable(input.collectionId);
  const quoted = `"${column.name}"`;

  for (const chunk of chunkForBulk([...new Set(input.keys)], MATCH_CHUNK)) {
    // The text index keys on `left(col, 500)`, so the predicate has to lead
    // with the same expression or the planner cannot enter it. The exact
    // equality stays as the second condition — the prefix narrows, it does not
    // decide.
    // `sql.param` and not a bare `${chunk}`: a bare array reaches the driver
    // as a JS value it renders element by element, and Postgres answers
    // `malformed array literal`. The existing state loaders bind arrays the
    // same way.
    const keyed = indexesTextPrefix(column.sqlType)
      ? sql`left(e.${sql.raw(quoted)}, ${TEXT_INDEX_PREFIX}) = ANY(
            SELECT left(v, ${TEXT_INDEX_PREFIX})
              FROM unnest(${sql.param(chunk)}::text[]) AS v)
          AND e.${sql.raw(quoted)} = ANY(${sql.param(chunk)}::text[])`
      : sql`e.${sql.raw(quoted)} = ANY(${sql.param(chunk)}::${sql.raw(column.sqlType)}[])`;

    const result = await db.execute(sql`
      SELECT e.${sql.raw(`"${SYS_COL.id}"`)}::text AS id,
             e.${sql.raw(quoted)}::text AS key
        FROM ${sql.raw(table)} e
       WHERE e.${sql.raw(`"${SYS_COL.team}"`)} = ${input.teamId}::uuid
         AND ${keyed}`);

    for (const row of result.rows) {
      const id = Reflect.get(row, "id");
      // Back through `matchKeyOf`: the driver returns `numeric` as a string
      // that may carry trailing zeros ("7.50"), and the caller looked the key
      // up under its canonical form.
      const key = matchKeyOf(input.field, Reflect.get(row, "key"));
      if (key === undefined || typeof id !== "string") continue;
      const bucket = found.get(key);
      if (bucket === undefined) found.set(key, [id]);
      else bucket.push(id);
    }
  }
  return found;
};

/**
 * Does ANY record of this team carry a value in the match column?
 *
 * Asked once, before the first call of a fresh walk. A `columns` source is
 * routinely declared before the `table` source that fills its key has ever
 * run, and walking an app's whole list to match it against an empty column is
 * the purest waste this engine can produce: every page paid for, nothing
 * found, repeated on every tick.
 */
export const hasAnyColumnValue = async (input: {
  collectionId: string;
  teamId: string;
  field: FieldDefinition;
}): Promise<boolean> => {
  const column = columnOf(input.field);
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
        FROM ${sql.raw(qualifiedCollectionTable(input.collectionId))} e
       WHERE e.${sql.raw(`"${SYS_COL.team}"`)} = ${input.teamId}::uuid
         AND e.${sql.raw(`"${column.name}"`)} IS NOT NULL
       LIMIT 1
    ) AS present`);
  return Reflect.get(result.rows[0] ?? {}, "present") === true;
};
