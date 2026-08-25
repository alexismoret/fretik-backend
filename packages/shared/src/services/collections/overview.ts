import { count, eq } from "drizzle-orm";
import db from "../../db";
import { collectionRecords } from "../../db/schema";
import type { CollectionOverviewItem } from "../../schemas/ontology";
import { listCollections } from "./retrieve";

/**
 * Per-type record counts for the home "Your objects" grid and the "AI
 * suggestions to review" tally — the team's visible types joined to one grouped
 * count over `collection_records` (by type + status, `(teamId, collectionId,
 * status)`-indexed), so the whole grid loads in a single round-trip instead of
 * one count per type. `total` counts confirmed records the team owns;
 * `suggested` counts the AI-proposed ones still awaiting review. Foreign
 * shared-in types (records owned elsewhere) report zero — this is the team's
 * own footprint.
 */
export const getCollectionsOverview = async (data: {
  organizationId: string;
  teamId: string;
}): Promise<{ types: CollectionOverviewItem[] }> => {
  const { organizationId, teamId } = data;

  const [types, countRows] = await Promise.all([
    listCollections({ organizationId, teamId }),
    db
      .select({
        collectionId: collectionRecords.collectionId,
        status: collectionRecords.status,
        count: count(),
      })
      .from(collectionRecords)
      .where(eq(collectionRecords.teamId, teamId))
      .groupBy(collectionRecords.collectionId, collectionRecords.status),
  ]);

  const totals = new Map<string, { total: number; suggested: number }>();
  for (const row of countRows) {
    const entry = totals.get(row.collectionId) ?? { total: 0, suggested: 0 };
    if (row.status === "confirmed") entry.total = row.count;
    else if (row.status === "suggested") entry.suggested = row.count;
    totals.set(row.collectionId, entry);
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
