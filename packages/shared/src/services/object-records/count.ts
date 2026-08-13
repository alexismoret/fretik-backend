import { and, count, eq } from "drizzle-orm";
import db from "../../db";
import { objectRecords } from "../../db/schema";
import { recordVisibilityCondition, resolveRecordTypeScope } from "./scope";

/**
 * How many confirmed records of one type the viewing team can see.
 *
 * EXACT, not the planner estimate. The estimate is right for "is this table big
 * enough to index" (`estimatedRowCount`), and wrong here for two reasons: it is
 * stale exactly after an import — the moment someone asks — and it counts the
 * physical table, ignoring the visibility arm a shared-in type needs.
 *
 * Affordable because it is on demand and scoped: `object_records_team_type_status_idx`
 * covers `(team_id, object_type_id, status)`, so this is an index-only scan of
 * the matching range, not a table scan. That is what makes it a per-call answer
 * rather than something to precompute or approximate.
 */
export const countRecordsForType = async (input: {
  objectTypeId: string;
  teamId: string;
}): Promise<number> => {
  const scope = await resolveRecordTypeScope({
    objectTypeId: input.objectTypeId,
    teamId: input.teamId,
  });
  const conditions = [
    eq(objectRecords.objectTypeId, input.objectTypeId),
    eq(objectRecords.status, "confirmed"),
  ];
  const visibility = recordVisibilityCondition({
    teamId: input.teamId,
    scope,
  });
  if (visibility) conditions.push(visibility);

  const [row] = await db
    .select({ total: count() })
    .from(objectRecords)
    .where(and(...conditions));
  return row?.total ?? 0;
};
