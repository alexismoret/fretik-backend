import { and, eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions, objectTypes } from "../../db/schema";
import { isMultiMember } from "../../db/schema/field-types";
import { recomputeSearchVectorsForType } from "../object-records/field-data";

/**
 * Typed views — the AI query surface for the dynamic-data graph. The chatbot's
 * SQL tool never reads `object_records` (raw JSONB → poor text-to-SQL); it reads
 * per-(team, type) views whose columns are cast from the type's field
 * definitions. This is the correctness mechanism of the AI query path: a typed
 * semantic layer the model cannot fall back out of.
 *
 * Per-team because field definitions are team-scoped and diverge — two teams'
 * `company` records carry different columns even though the type is one
 * org-scoped row. So the view name carries a team discriminator (collision-free
 * in the flat `public` namespace), and the body filters BOTH `object_type_id`
 * and `team_id` as literals (RLS via `security_invoker` is defence in depth).
 *
 * `security_invoker = on` ⇒ the view runs with the QUERYING role's privileges,
 * so the `fretik_sql_tool` RLS policies on `object_records` / `object_types`
 * apply (PostgreSQL ≥ 15; deployed PG is 17). Each view also needs an explicit
 * `GRANT SELECT` to that role — re-applied after every DROP+CREATE because the
 * grant is dropped with the view.
 */

/** Least-privilege role the SQL tool connects as (see `harden_sql_tool`). */
const SQL_TOOL_ROLE = "fretik_sql_tool";

/**
 * Strict slug grammar, RE-VALIDATED here before composing any DDL identifier —
 * the anti-DDL-injection boundary. Object-type and field keys are already
 * slug-validated at write, but the view layer owns its own safety: a key that
 * fails this never reaches a `CREATE`.
 */
const SAFE_IDENT = /^[a-z][a-z0-9_]*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres identifier limit (NAMEDATALEN − 1). Silent truncation past this. */
const MAX_PG_IDENT = 63;
/** Fixed overhead of `v_<key>_<12 hex>` leaves this many chars for the key. */
const MAX_KEY_IN_VIEW = MAX_PG_IDENT - "v_".length - 1 - 12; // 48

/**
 * High-entropy 12-hex team discriminator. v7 UUIDs lead with the millisecond
 * timestamp, so two teams created in the same millisecond share a prefix —
 * the TAIL (random/counter bits) is used instead.
 */
const teamSuffix = (teamId: string): string =>
  teamId.replace(/-/g, "").slice(-12);

const assertSafeUuid = (value: string, what: string): void => {
  if (!UUID_RE.test(value)) {
    throw new Error(`Refusing to compose DDL with a non-UUID ${what}`);
  }
};

const assertSafeKey = (key: string, what: string): void => {
  if (!SAFE_IDENT.test(key) || key.length > 60) {
    throw new Error(`Refusing to compose DDL with an unsafe ${what}: '${key}'`);
  }
};

/** The typed view name for a (type key, team). `v_<key>_<teamhex>`. */
export const typedViewName = (typeKey: string, teamId: string): string => {
  assertSafeKey(typeKey, "object type key");
  return `v_${typeKey.slice(0, MAX_KEY_IN_VIEW)}_${teamSuffix(teamId)}`;
};

/**
 * SQL expression projecting a field's JSONB value to its typed column, used
 * IDENTICALLY in the view column and in any expression index so the planner
 * matches them. Casts are GUARDED (a regex/`CASE` gate) so a malformed value —
 * possible because the document mirror writes leniently — yields NULL instead
 * of erroring the whole query. Every guard is IMMUTABLE so it is index-safe.
 * `key` is asserted slug-safe by the caller, so embedding it is injection-free.
 */
const castExpr = (def: FieldDefinition): string => {
  const text = `data->>'${def.key}'`;
  switch (def.type) {
    case "number":
    case "rating":
      return `CASE WHEN (${text}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${text})::numeric END`;
    case "date":
      // Native text→date (`::date`, `to_date`) is STABLE (DateStyle/locale), so
      // it can't back an index. `fretik_text_to_date` (migration
      // immutable_jsonb_date_fn) is a fixed-format IMMUTABLE parser → NULL on
      // malformed/invalid input. Same expression in the view column AND the
      // index, so the planner matches them. The agent never sees it — it queries
      // the resulting `date` column.
      return `fretik_text_to_date(${text})`;
    case "datetime":
      // `::timestamptz` is STABLE (tz-dependent), so it is exposed in the view
      // but never indexed. Guarded all the same.
      return `CASE WHEN (${text}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (${text})::timestamptz END`;
    case "boolean":
      return `CASE WHEN lower(${text}) IN ('true','false','t','f') THEN (${text})::boolean END`;
    case "multi_select":
      // Keep the array as JSONB (queryable with `@>` / `?`); no cast to error.
      return `data->'${def.key}'`;
    default:
      // text / email / url / markdown / phone — raw text, never errors.
      return text;
  }
};

/**
 * Project a `relation` field: a JSONB array of `{id, label}` for the active
 * edges of the field's backing link type, correlated on the outer record id.
 * Relations are NOT in `data` — they live in `links` — so the view exposes them
 * via this correlated subquery. RLS on `links` / `object_records` / `link_types`
 * (double-armed for `fretik_sql_tool`) scopes the rows under `security_invoker`;
 * the team filter is pinned to the generation team for precision. A relation
 * field with no bound link type projects an empty array. `linkTypeKey` is
 * re-validated slug-safe before embedding (the anti-DDL-injection boundary).
 */
const relationProjection = (def: FieldDefinition, teamId: string): string => {
  const linkTypeKey =
    "linkTypeKey" in def.config ? def.config.linkTypeKey : undefined;
  if (!linkTypeKey || !SAFE_IDENT.test(linkTypeKey)) return `'[]'::jsonb`;
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', rt.id, 'label', rt.label) ORDER BY l.created_at)
    FROM links l
    JOIN object_records rt ON rt.id = l.to_record_id
    JOIN link_types lt ON lt.id = l.link_type_id
    WHERE l.from_record_id = object_records.id
      AND lt.normalized_key = '${linkTypeKey}'
      AND lt.team_id = '${teamId}'::uuid
      AND l.valid_to IS NULL AND l.invalidated_at IS NULL
  ), '[]'::jsonb)`;
};

/**
 * Project a `member` field: the assigned teammate userId(s) from `data`. Single
 * assignee → the raw text id; `multiple` → the JSONB array (queryable with
 * `?`/`@>`). The AI filters on the id; display names are resolved client-side
 * (and by the member-list tool), so the view stays free of a cross-schema join
 * to the auth `user` table.
 */
const memberExpr = (def: FieldDefinition): string =>
  isMultiMember(def.config) ? `data->'${def.key}'` : `data->>'${def.key}'`;

/**
 * Project a `money` field into two columns — `<key>_amount` (guarded numeric)
 * and `<key>_currency` (ISO text) — from the `{ amount, currencyCode }` object
 * in `data`, so the AI can `SUM(<key>_amount)` and group by currency.
 */
const moneyAmountExpr = (def: FieldDefinition): string => {
  const text = `data->'${def.key}'->>'amount'`;
  return `CASE WHEN (${text}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${text})::numeric END`;
};
const moneyCurrencyExpr = (def: FieldDefinition): string =>
  `data->'${def.key}'->>'currencyCode'`;

/**
 * Project a `rollup` field: a read-only aggregate over the records linked
 * through a sibling `relation` field. Resolves that relation's backing
 * `linkTypeKey` from the type's own field set, then aggregates the target
 * field's value across the active edges — the same correlated-subquery shape as
 * `relationProjection`, with an aggregate instead of `jsonb_agg`.
 *
 * `fn`:
 *   - `count` → number of linked records (target field ignored)
 *   - `count_not_empty` / `percent_not_empty` → (share of) linked records whose
 *     target field is set
 *   - `sum` / `avg` / `min` / `max` → numeric aggregate of the target field,
 *     guarded so a non-numeric value is skipped (NULL) rather than erroring.
 *
 * Misconfigured (no relation field, unbound relation, or a numeric fn with no
 * target) → a constant NULL column, so the view never fails to build. `key`s
 * are re-validated slug-safe before embedding (anti-DDL-injection boundary).
 */
const rollupProjection = (
  def: FieldDefinition,
  fields: FieldDefinition[],
  teamId: string,
): string => {
  const cfg = def.config;
  const relationFieldKey =
    "relationFieldKey" in cfg ? cfg.relationFieldKey : undefined;
  const targetFieldKey =
    "targetFieldKey" in cfg ? cfg.targetFieldKey : undefined;
  const fn = "fn" in cfg ? cfg.fn : undefined;
  if (!relationFieldKey || !fn) return `NULL`;

  const relationField = fields.find(
    (f) => f.key === relationFieldKey && f.type === "relation",
  );
  const linkTypeKey =
    relationField && "linkTypeKey" in relationField.config
      ? relationField.config.linkTypeKey
      : undefined;
  if (!linkTypeKey || !SAFE_IDENT.test(linkTypeKey)) return `NULL`;

  // Guarded numeric read of the target field on a linked record (`rt`).
  const needsTarget =
    fn === "sum" || fn === "avg" || fn === "min" || fn === "max";
  if (needsTarget && (!targetFieldKey || !SAFE_IDENT.test(targetFieldKey))) {
    return `NULL`;
  }
  const targetText = targetFieldKey
    ? `rt.data->>'${targetFieldKey}'`
    : undefined;
  const targetNumeric = targetText
    ? `CASE WHEN (${targetText}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${targetText})::numeric END`
    : undefined;

  let agg: string;
  switch (fn) {
    case "count":
      agg = `count(*)`;
      break;
    case "count_not_empty":
      agg = targetText
        ? `count(*) FILTER (WHERE (${targetText}) IS NOT NULL AND (${targetText}) <> '')`
        : `count(*)`;
      break;
    case "percent_not_empty":
      agg = targetText
        ? `round(100.0 * count(*) FILTER (WHERE (${targetText}) IS NOT NULL AND (${targetText}) <> '') / NULLIF(count(*), 0), 2)`
        : `100`;
      break;
    case "sum":
      agg = `COALESCE(sum(${targetNumeric}), 0)`;
      break;
    case "avg":
      agg = `avg(${targetNumeric})`;
      break;
    case "min":
      agg = `min(${targetNumeric})`;
      break;
    case "max":
      agg = `max(${targetNumeric})`;
      break;
  }

  // count-family defaults to 0 (a record with no links has zero, not NULL);
  // numeric aggregates stay NULL when there is nothing to aggregate.
  const zeroDefault =
    fn === "count" || fn === "count_not_empty" || fn === "sum";
  const body = `(
    SELECT ${agg}
    FROM links l
    JOIN object_records rt ON rt.id = l.to_record_id
    JOIN link_types lt ON lt.id = l.link_type_id
    WHERE l.from_record_id = object_records.id
      AND lt.normalized_key = '${linkTypeKey}'
      AND lt.team_id = '${teamId}'::uuid
      AND l.valid_to IS NULL AND l.invalidated_at IS NULL
  )`;
  return zeroDefault ? `COALESCE(${body}, 0)` : body;
};

/**
 * Fetch a type's key + the team's ENABLED field definitions for it, reading the
 * DB directly (NOT the Redis cache): this runs at catalog-change time and must
 * see the post-change truth, and the cache is invalidated out-of-band by the
 * field-definition write path.
 */
const loadTypeShape = async (
  exec: Transaction | typeof db,
  objectTypeId: string,
  teamId: string,
): Promise<{ key: string; fields: FieldDefinition[] } | null> => {
  const type = await exec.query.objectTypes.findFirst({
    columns: { key: true },
    where: { id: objectTypeId },
  });
  if (!type) return null;
  const fields = await exec
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, teamId),
        eq(fieldDefinitions.objectTypeId, objectTypeId),
        eq(fieldDefinitions.enabled, true),
      ),
    );
  return { key: type.key, fields };
};

/** Run one raw DDL statement on the owner connection (or an enlisting tx). */
const ddl = async (
  exec: Transaction | typeof db,
  stmt: string,
): Promise<void> => {
  await exec.execute(sql.raw(stmt));
};

/**
 * Generate the global generic view `v_record(_id, _type_key, _label, _status)` —
 * common columns only, never `data`. The model joins it to resolve a
 * polymorphic link target whose concrete type it doesn't know. RLS on
 * `object_records` + `object_types` scopes the rows under `security_invoker`.
 * Idempotent (`CREATE OR REPLACE`); its shape is fixed.
 */
export const syncRecordView = async (input?: {
  tx?: Transaction;
}): Promise<void> => {
  const exec = input?.tx ?? db;
  await ddl(
    exec,
    `CREATE OR REPLACE VIEW v_record WITH (security_invoker = on) AS
       SELECT r.id AS _id, ot.key AS _type_key, r.label AS _label, r.status::text AS _status
       FROM object_records r
       JOIN object_types ot ON ot.id = r.object_type_id`,
  );
  await ddl(exec, `GRANT SELECT ON v_record TO ${SQL_TOOL_ROLE}`);
};

/**
 * (Re)generate the typed view for one (team, object type). DROP+CREATE (not
 * CREATE OR REPLACE — the column set changes when fields are added/removed/
 * retyped, which OR REPLACE cannot do), then re-GRANT and refresh the
 * expression indexes for the type's hot (filterable) fields.
 *
 * Structural columns are `_`-prefixed (`_id`, `_status`, …) so they can never
 * collide with a field-derived column (field keys must start with a letter) —
 * e.g. a `task` type's business `status` field stays `status`.
 *
 * Best-effort on indexes (a perf optimization): an index failure is logged, not
 * thrown, so it never blocks the catalog change. The view itself is correctness
 * — its failure propagates.
 */
export const syncTypedView = async (input: {
  objectTypeId: string;
  teamId: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  assertSafeUuid(input.objectTypeId, "object type id");
  assertSafeUuid(input.teamId, "team id");

  const shape = await loadTypeShape(exec, input.objectTypeId, input.teamId);
  if (!shape) return;

  const name = typedViewName(shape.key, input.teamId);
  const columns = ["id AS _id", "label AS _label", "status::text AS _status"];
  columns.push("created_at AS _created_at", "updated_at AS _updated_at");
  columns.push("document_id AS _document_id");
  // Actor stamps (Notion's Created-by / Last-edited-by), exposed as the
  // teammate userId who created / last edited the record.
  columns.push(
    "created_by_user_id AS _created_by",
    "updated_by_user_id AS _updated_by",
  );
  for (const def of shape.fields) {
    assertSafeKey(def.key, "field key");
    // Relation / member / money have bespoke projections (graph edges, userIds,
    // or a two-column money split); everything else uses the guarded cast.
    if (def.type === "relation") {
      columns.push(`${relationProjection(def, input.teamId)} AS ${def.key}`);
    } else if (def.type === "rollup") {
      columns.push(
        `${rollupProjection(def, shape.fields, input.teamId)} AS ${def.key}`,
      );
    } else if (def.type === "member") {
      columns.push(`${memberExpr(def)} AS ${def.key}`);
    } else if (def.type === "money") {
      columns.push(`${moneyAmountExpr(def)} AS ${def.key}_amount`);
      columns.push(`${moneyCurrencyExpr(def)} AS ${def.key}_currency`);
    } else {
      columns.push(`${castExpr(def)} AS ${def.key}`);
    }
  }

  await ddl(exec, `DROP VIEW IF EXISTS ${name}`);
  await ddl(
    exec,
    `CREATE VIEW ${name} WITH (security_invoker = on) AS
       SELECT ${columns.join(", ")}
       FROM object_records
       WHERE object_type_id = '${input.objectTypeId}'::uuid
         AND team_id = '${input.teamId}'::uuid`,
  );
  await ddl(exec, `GRANT SELECT ON ${name} TO ${SQL_TOOL_ROLE}`);

  await syncExpressionIndexes(exec, input.objectTypeId, shape.fields);
};

/** Drop the typed view for a (team, object type). Used on type deletion. */
export const dropTypedView = async (input: {
  typeKey: string;
  teamId: string;
  tx?: Transaction;
}): Promise<void> => {
  const exec = input.tx ?? db;
  const name = typedViewName(input.typeKey, input.teamId);
  await ddl(exec, `DROP VIEW IF EXISTS ${name}`);
};

/**
 * Expression-index generator (performance ladder rungs 1–2), driven by
 * `displayInFilters`. For a hot field, on the SAME guarded expression the view
 * exposes (so the planner uses it):
 *   - number / date → typed btree expression index (range, sort, equality)
 *   - text-like (text/email/url/select) → GIN trigram (ILIKE / substring)
 * datetime (non-immutable cast), boolean (poor selectivity), and multi_select
 * (covered by the global GIN(data)) are skipped. Partial by `object_type_id`.
 */
const syncExpressionIndexes = async (
  exec: Transaction | typeof db,
  objectTypeId: string,
  fields: FieldDefinition[],
): Promise<void> => {
  const tail = objectTypeId.replace(/-/g, "").slice(-12);
  for (const def of fields) {
    if (!def.displayInFilters) continue;
    assertSafeKey(def.key, "field key");
    const keyPart = def.key.slice(0, 30);
    const where = `WHERE object_type_id = '${objectTypeId}'::uuid`;
    let stmt: string | null = null;
    if (def.type === "number" || def.type === "date") {
      stmt = `CREATE INDEX IF NOT EXISTS ix_or_${tail}_${keyPart} ON object_records ((${castExpr(def)})) ${where}`;
    } else if (
      def.type === "text" ||
      def.type === "email" ||
      def.type === "url" ||
      def.type === "select"
    ) {
      stmt = `CREATE INDEX IF NOT EXISTS ixt_or_${tail}_${keyPart} ON object_records USING gin ((${castExpr(def)}) gin_trgm_ops) ${where}`;
    }
    if (!stmt) continue;
    try {
      // SAVEPOINT-isolate each index: a perf-only, best-effort index failure
      // must never poison the enclosing catalog-change transaction (in
      // Postgres any statement error aborts the whole tx until rollback).
      // `.transaction()` is a real tx on `db` and a SAVEPOINT on a `tx`.
      await exec.transaction(async (sp) => {
        await ddl(sp, stmt);
      });
    } catch (err) {
      console.warn(
        `[sync-typed-view] expression index for field '${def.key}' skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
};

/**
 * Refresh the derived artifacts after a field-definition (catalog) change:
 * regenerate the team's typed view (new column set) + its expression indexes,
 * and recompute its records' search vectors. A no-op for org-template scope
 * (`teamId` null) — templates have no runtime view; teams get one at creation.
 *
 * Call ENLISTED in the field-def write transaction (pass `tx`): the field-def
 * change, the view, and the vectors then commit atomically — never a committed
 * field change with a stale view. Errors propagate (abort the tx); only the
 * perf-only expression indexes are best-effort, SAVEPOINT-isolated inside
 * `syncTypedView` so they can't abort the change.
 */
export const refreshTypedViewAfterCatalogChange = async (input: {
  organizationId: string;
  objectTypeId: string;
  teamId: string | null;
  tx?: Transaction;
}): Promise<void> => {
  if (!input.teamId) return;
  await syncTypedView({
    objectTypeId: input.objectTypeId,
    teamId: input.teamId,
    tx: input.tx,
  });
  await recomputeSearchVectorsForType({
    organizationId: input.organizationId,
    objectTypeId: input.objectTypeId,
    teamId: input.teamId,
    tx: input.tx,
  });
};

/**
 * (Re)generate every typed view a team can query: one per object type visible
 * to it (its own team-scoped types + the org/system types), using that team's
 * field definitions. Used at team creation and by the backfill script. The
 * generic `v_record` is global — sync it once separately.
 */
export const syncAllTypedViewsForTeam = async (input: {
  organizationId: string;
  teamId: string;
  tx?: Transaction;
}): Promise<number> => {
  const exec = input.tx ?? db;
  const types = await exec
    .select({ id: objectTypes.id })
    .from(objectTypes)
    .where(
      // Types the team sees: its own + the org/system ones (teamId IS NULL).
      sql`${objectTypes.organizationId} = ${input.organizationId} AND (${objectTypes.teamId} = ${input.teamId} OR ${objectTypes.teamId} IS NULL)`,
    );
  for (const type of types) {
    await syncTypedView({
      objectTypeId: type.id,
      teamId: input.teamId,
      tx: input.tx,
    });
  }
  return types.length;
};
