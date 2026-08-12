import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition, OntologyStatus } from "../../db/schema";
import { isMultiMember, objectRecords } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import {
  assertSafeKey,
  qualifiedObjectTable,
} from "../object-schema/identifiers";
import { noteIndexWanted } from "../object-schema/reconcile-indexes";
import { recordVisibilityCondition, resolveRecordTypeScope } from "./scope";

/** One group's true totals over ALL its records (not just a loaded page). */
export interface GroupAggregate {
  /** The group column value — a select option value or a member user id; `null`
   *  is the uncategorized / unassigned lane. */
  value: string | null;
  count: number;
  /** Sum of `sumKey` over the group, or `null` when no `sumKey` was requested. */
  sum: number | null;
}

/**
 * Lanes returned at most. A validated `groupKey` is already naturally bounded —
 * a `select`'s options, or a team's members — so this is a backstop, not a
 * policy: it exists so a column that somehow yields one group per record can
 * never turn one request into a several-hundred-megabyte response. A board with
 * this many lanes is unusable long before the cap bites.
 */
const MAX_GROUP_LANES = 200;

/**
 * Reject a `groupKey` whose column would not yield a bounded set of lanes.
 * Names what IS groupable rather than what is not — the caller is a UI picking a
 * board column, and the list of valid choices is the actionable half.
 */
const assertGroupable = (
  fieldDefs: FieldDefinition[],
  groupKey: string,
): void => {
  const def = fieldDefs.find((field) => field.key === groupKey);
  const groupable =
    def !== undefined &&
    def.enabled &&
    (def.type === "select" ||
      (def.type === "member" && !isMultiMember(def.config)));
  if (groupable) return;
  const valid = fieldDefs
    .filter(
      (field) =>
        field.enabled &&
        (field.type === "select" ||
          (field.type === "member" && !isMultiMember(field.config))),
    )
    .map((field) => field.key);
  return throwHttpError(
    400,
    badRequest(
      `Cannot group by '${groupKey}': grouping needs a select field or a single-member field. Valid keys: ${valid.length > 0 ? valid.join(", ") : "(none on this type)"}`,
    ),
  );
};

/**
 * Reject a `sumKey` that is not numeric, and a `sumKind` that disagrees with the
 * definition. The kind picks the column (`money` reads `<key>_amount`), so a
 * mismatch reaches Postgres as a missing column — a 500 for what is a caller
 * mistake with an obvious name.
 */
const assertSummable = (
  fieldDefs: FieldDefinition[],
  sumKey: string,
  sumKind: "number" | "money" | undefined,
): void => {
  const def = fieldDefs.find((field) => field.key === sumKey);
  if (def === undefined || !def.enabled) {
    return throwHttpError(
      400,
      badRequest(`Cannot sum '${sumKey}': no such field on this type.`),
    );
  }
  if (def.type !== "number" && def.type !== "money") {
    return throwHttpError(
      400,
      badRequest(
        `Cannot sum '${sumKey}': it is a ${def.type} field, and only number and money fields can be summed.`,
      ),
    );
  }
  if (sumKind !== undefined && sumKind !== def.type) {
    return throwHttpError(
      400,
      badRequest(
        `Field '${sumKey}' is a ${def.type} field, not ${sumKind}. Drop sumKind or match the field's type.`,
      ),
    );
  }
};

/**
 * Count (and optionally sum) a type's records grouped by one field column — the
 * server-side backing for the kanban's per-column header (count + running sum)
 * so those totals stay exact while each lane lazy-loads its cards. One
 * `GROUP BY` over the type's extension table, scoped to what the viewing team
 * may see (shared with the list query via `resolveRecordTypeScope`).
 *
 * `groupKey` is a `select` field's column or a single-`member` field's `uuid`
 * column; `sumKey` is a `number` column or a `money` field (`<key>_amount`).
 * Keys are slug-guarded before embedding (anti-DDL-injection boundary) AND
 * checked against the type's field definitions: the slug guard only proves a key
 * cannot inject DDL, not that grouping by it is bounded. Grouping by a free-text
 * or date column yields one lane per distinct value — on a large type that is
 * one row per record, in a single un-paginated response. The type check is what
 * makes the shape of this query knowable in advance; `MAX_GROUP_LANES` is the
 * backstop behind it.
 *
 * A `multi_select` (`text[]`) and a multiple-`member` (`uuid[]`) are rejected for
 * a second reason: casting an array to text groups by exact COMBINATION
 * (`{a,b}`), which is never the histogram a caller wants. `aggregateRecords`
 * unnests them through a LATERAL join — use it when you need that.
 */
export const aggregateRecordsByGroup = async (data: {
  teamId: string;
  objectTypeId: string;
  groupKey: string;
  status?: OntologyStatus;
  sumKey?: string;
  sumKind?: "number" | "money";
}): Promise<GroupAggregate[]> => {
  const {
    teamId,
    objectTypeId,
    groupKey,
    status = "confirmed",
    sumKey,
    sumKind,
  } = data;
  assertSafeKey(groupKey, "group key");
  if (sumKey) assertSafeKey(sumKey, "sum key");

  const fieldDefs = await getFieldDefinitionsForTeam({ teamId, objectTypeId });
  assertGroupable(fieldDefs, groupKey);
  if (sumKey) assertSummable(fieldDefs, sumKey, sumKind);
  // The read half of the index loop: a grouping or summing column is exactly a
  // column the planner wants an index on, and this is the only record read path
  // that was not saying so. Fire-and-forget, free unless one was dropped.
  noteIndexWanted({
    fields: fieldDefs,
    keys: sumKey ? [groupKey, sumKey] : [groupKey],
  });

  const scope = await resolveRecordTypeScope({ objectTypeId, teamId });
  const conditions = [
    eq(objectRecords.objectTypeId, objectTypeId),
    eq(objectRecords.status, status),
  ];
  const visibility = recordVisibilityCondition({ teamId, scope });
  if (visibility) conditions.push(visibility);

  const table = qualifiedObjectTable(objectTypeId);
  const groupCol = sql.raw(`e."${groupKey}"`);
  const sumColName = sumKind === "money" ? `${sumKey}_amount` : sumKey;
  const sumExpr =
    sumKey && sumColName
      ? sql`COALESCE(sum(e.${sql.raw(`"${sumColName}"`)}), 0)::float8`
      : sql`NULL`;

  const result = await db.execute(sql`
    SELECT ${groupCol}::text AS group_value, count(*)::int AS cnt, ${sumExpr} AS total
    FROM ${objectRecords}
    JOIN ${sql.raw(table)} e ON e."id" = ${objectRecords.id}
    WHERE ${and(...conditions)}
    GROUP BY ${groupCol}
    LIMIT ${MAX_GROUP_LANES}
  `);

  return result.rows.map((row) => ({
    // `group_value` is cast to text in SQL, so it is a string or null.
    value: typeof row.group_value === "string" ? row.group_value : null,
    count: Number(row.cnt),
    sum: row.total == null ? null : Number(row.total),
  }));
};
