import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { OntologyStatus } from "../../db/schema";
import { objectRecords } from "../../db/schema";
import {
  assertSafeKey,
  qualifiedObjectTable,
} from "../object-schema/identifiers";
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
 * Count (and optionally sum) a type's records grouped by one field column — the
 * server-side backing for the kanban's per-column header (count + running sum)
 * so those totals stay exact while each lane lazy-loads its cards. One
 * `GROUP BY` over the type's extension table, scoped to what the viewing team
 * may see (shared with the list query via `resolveRecordTypeScope`).
 *
 * `groupKey` is a `select` field's column or a single-`member` field's `uuid`
 * column; `sumKey` is a `number` column or a `money` field (`<key>_amount`).
 * Keys are slug-guarded before embedding (anti-DDL-injection boundary).
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
  `);

  return result.rows.map((row) => ({
    // `group_value` is cast to text in SQL, so it is a string or null.
    value: typeof row.group_value === "string" ? row.group_value : null,
    count: Number(row.cnt),
    sum: row.total == null ? null : Number(row.total),
  }));
};
