import db from "../../db";
import type { CollectionSyncRun } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";

/**
 * Each source's most recent run, in ONE query for the whole set.
 *
 * Read whole and reduced in memory rather than with a `DISTINCT ON`: retention
 * caps a source at `SYNC_LIMITS.runHistoryLimit` runs (`run-source.ts` trims
 * post-insert), so the worst case is twenty rows per source — bounded by a
 * contract, which is the only thing that makes "read them all" a fair trade for
 * a simpler statement.
 */
export const loadLastRuns = async (
  sourceIds: readonly string[],
): Promise<Map<string, CollectionSyncRun>> => {
  const lastRuns = new Map<string, CollectionSyncRun>();
  if (sourceIds.length === 0) return lastRuns;
  for (const chunk of chunkForBulk([...sourceIds])) {
    const rows = await db.query.collectionSyncRuns.findMany({
      where: { syncSourceId: { in: chunk } },
      orderBy: { startedAt: "desc" },
    });
    for (const row of rows) {
      if (!lastRuns.has(row.syncSourceId)) lastRuns.set(row.syncSourceId, row);
    }
  }
  return lastRuns;
};
