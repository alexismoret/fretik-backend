import { and, eq, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions, linkTypes } from "../../db/schema";
import {
  assertSafeKey,
  qualifiedCollectionTable,
  SAFE_IDENT,
} from "./identifiers";

/**
 * Computed (graph-derived) field values — `relation` and `rollup`. These never
 * become physical columns: relations live in the `links` graph and rollups are
 * aggregates over linked records. The old per-type view projected them; with the
 * views gone, this module computes them ON DEMAND for a page of records (the UI
 * relation chips + rollup cells, and the AI `getRecord` tool).
 *
 * The projections are correlated subqueries on `links`, keyed on the registry id
 * `r.id`; rollups additionally join the TARGET type's extension table to read
 * the already-numeric column (no cast). All keys are slug-guarded before
 * embedding (anti-DDL-injection boundary); record ids are parameterized.
 */

type LinkTargetMap = Map<string, string | null>;

/**
 * System property field types → the `collection_records` (aliased `r`) column they
 * project. Read-only, surfaced as fields so views can sort/filter/show them.
 */
const SYSTEM_PROJECTION: Partial<Record<FieldDefinition["type"], string>> = {
  created_time: "r.created_at",
  last_edited_time: "r.updated_at",
  created_by: "r.created_by_user_id",
  last_edited_by: "r.updated_by_user_id",
};

/** Relation field → jsonb array of `{id,label}` for its active edges. */
const relationProjection = (def: FieldDefinition, teamId: string): string => {
  const linkTypeKey =
    "linkTypeKey" in def.config ? def.config.linkTypeKey : undefined;
  if (!linkTypeKey || !SAFE_IDENT.test(linkTypeKey)) return `'[]'::jsonb`;
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', rt.id, 'label', rt.label) ORDER BY l.created_at)
    FROM links l
    JOIN collection_records rt ON rt.id = l.to_record_id
    JOIN link_types lt ON lt.id = l.link_type_id
    WHERE l.from_record_id = r.id
      AND lt.normalized_key = '${linkTypeKey}'
      AND lt.team_id = '${teamId}'::uuid
      AND l.valid_to IS NULL AND l.invalidated_at IS NULL
  ), '[]'::jsonb)`;
};

/** Rollup field → an aggregate over the records linked via a sibling relation. */
const rollupProjection = (
  def: FieldDefinition,
  fields: FieldDefinition[],
  linkTargets: LinkTargetMap,
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

  const needsTarget =
    fn === "sum" ||
    fn === "avg" ||
    fn === "min" ||
    fn === "max" ||
    fn === "percent_checked";
  if (needsTarget && (!targetFieldKey || !SAFE_IDENT.test(targetFieldKey))) {
    return `NULL`;
  }
  const targetTypeId = linkTargets.get(linkTypeKey);
  const targetJoin =
    targetFieldKey && targetTypeId
      ? `JOIN ${qualifiedCollectionTable(targetTypeId)} te ON te.id = rt.id`
      : "";
  const targetCol =
    targetFieldKey && targetTypeId ? `te."${targetFieldKey}"` : undefined;
  if (needsTarget && !targetCol) return `NULL`;

  let agg: string;
  switch (fn) {
    case "count":
      agg = `count(*)`;
      break;
    case "count_not_empty":
      agg = targetCol
        ? `count(*) FILTER (WHERE ${targetCol} IS NOT NULL)`
        : `count(*)`;
      break;
    case "percent_not_empty":
      agg = targetCol
        ? `round(100.0 * count(*) FILTER (WHERE ${targetCol} IS NOT NULL) / NULLIF(count(*), 0), 2)`
        : `100`;
      break;
    // Notion "Percent checked": share of linked records whose boolean target
    // is true. Guarded to a boolean target in the config UI + schema.
    case "percent_checked":
      agg = `round(100.0 * count(*) FILTER (WHERE ${targetCol} IS TRUE) / NULLIF(count(*), 0), 2)`;
      break;
    case "sum":
      agg = `COALESCE(sum(${targetCol}), 0)`;
      break;
    case "avg":
      agg = `avg(${targetCol})`;
      break;
    case "min":
      agg = `min(${targetCol})`;
      break;
    case "max":
      agg = `max(${targetCol})`;
      break;
    default:
      return `NULL`;
  }
  const zeroDefault =
    fn === "count" || fn === "count_not_empty" || fn === "sum";
  const body = `(
    SELECT ${agg}
    FROM links l
    JOIN collection_records rt ON rt.id = l.to_record_id
    JOIN link_types lt ON lt.id = l.link_type_id
    ${targetJoin}
    WHERE l.from_record_id = r.id
      AND lt.normalized_key = '${linkTypeKey}'
      AND lt.team_id = '${teamId}'::uuid
      AND l.valid_to IS NULL AND l.invalidated_at IS NULL
  )`;
  return zeroDefault ? `COALESCE(${body}, 0)` : body;
};

/** linkType.normalizedKey → toCollectionId for the team (rollup target join). */
const loadLinkTargets = async (
  exec: Executor,
  teamId: string,
): Promise<LinkTargetMap> => {
  const rows = await exec
    .select({ key: linkTypes.normalizedKey, target: linkTypes.toCollectionId })
    .from(linkTypes)
    .where(eq(linkTypes.teamId, teamId));
  const map: LinkTargetMap = new Map();
  for (const row of rows) map.set(row.key, row.target);
  return map;
};

/**
 * Compute the relation + rollup values for a page of records of ONE type,
 * returned as `Map<recordId, {fieldKey: value}>`. Best-effort: an empty map on
 * any failure (a missing target table, etc.) so a list never fails on computed
 * cells. Returns an empty map when the type has no relation/rollup fields.
 */
export const computeRelationRollupValues = async (input: {
  teamId: string;
  collectionId: string;
  recordIds: string[];
  tx?: Executor;
}): Promise<Map<string, Record<string, unknown>>> => {
  const empty = new Map<string, Record<string, unknown>>();
  if (input.recordIds.length === 0) return empty;
  const exec = input.tx ?? db;

  const fields = await exec
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, input.teamId),
        eq(fieldDefinitions.collectionId, input.collectionId),
        eq(fieldDefinitions.enabled, true),
      ),
    );
  const computed = fields.filter(
    (f) =>
      f.type === "relation" ||
      f.type === "rollup" ||
      f.type in SYSTEM_PROJECTION,
  );
  if (computed.length === 0) return empty;

  const linkTargets = await loadLinkTargets(exec, input.teamId);
  const cols = ["r.id::text AS _id"];
  for (const def of computed) {
    assertSafeKey(def.key, "field key");
    const system = SYSTEM_PROJECTION[def.type];
    const expr = system
      ? system
      : def.type === "relation"
        ? relationProjection(def, input.teamId)
        : rollupProjection(def, fields, linkTargets, input.teamId);
    cols.push(`${expr} AS "${def.key}"`);
  }

  try {
    const res = await exec.execute(
      sql`SELECT ${sql.raw(cols.join(", "))}
          FROM collection_records r
          WHERE r.id = ANY(${sql.param(input.recordIds)}::uuid[])`,
    );
    const map = new Map<string, Record<string, unknown>>();
    for (const row of res.rows) {
      const id = String(row._id);
      const values: Record<string, unknown> = {};
      for (const def of computed) values[def.key] = row[def.key];
      map.set(id, values);
    }
    return map;
  } catch {
    return empty;
  }
};
