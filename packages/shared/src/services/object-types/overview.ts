import { count, eq } from "drizzle-orm";
import db from "../../db";
import { objectRecords } from "../../db/schema";
import type { ObjectTypeOverviewItem } from "../../schemas/ontology";
import { listObjectTypes } from "./retrieve";

/**
 * Per-type record counts for the home "Your objects" grid and the "AI
 * suggestions to review" tally — the team's visible types joined to one grouped
 * count over `object_records` (by type + status, `(teamId, objectTypeId,
 * status)`-indexed), so the whole grid loads in a single round-trip instead of
 * one count per type. `total` counts confirmed records the team owns;
 * `suggested` counts the AI-proposed ones still awaiting review. Foreign
 * shared-in types (records owned elsewhere) report zero — this is the team's
 * own footprint.
 */
export const getObjectTypesOverview = async (data: {
  organizationId: string;
  teamId: string;
}): Promise<{ types: ObjectTypeOverviewItem[] }> => {
  const { organizationId, teamId } = data;

  const [types, countRows] = await Promise.all([
    listObjectTypes({ organizationId, teamId }),
    db
      .select({
        objectTypeId: objectRecords.objectTypeId,
        status: objectRecords.status,
        count: count(),
      })
      .from(objectRecords)
      .where(eq(objectRecords.teamId, teamId))
      .groupBy(objectRecords.objectTypeId, objectRecords.status),
  ]);

  const totals = new Map<string, { total: number; suggested: number }>();
  for (const row of countRows) {
    const entry = totals.get(row.objectTypeId) ?? { total: 0, suggested: 0 };
    if (row.status === "confirmed") entry.total = row.count;
    else if (row.status === "suggested") entry.suggested = row.count;
    totals.set(row.objectTypeId, entry);
  }

  return {
    types: types.map((type) => {
      const counts = totals.get(type.id) ?? { total: 0, suggested: 0 };
      return {
        id: type.id,
        key: type.key,
        label: type.label,
        icon: type.icon,
        color: type.color,
        total: counts.total,
        suggested: counts.suggested,
      };
    }),
  };
};
