import { and, desc, eq } from "drizzle-orm";
import db from "../../db";
import { collectionSyncRuns } from "../../db/schema";
import {
  SYNC_LIMITS,
  type SyncRunResponse,
} from "../../schemas/collection-sync";
import { serializeSyncRun } from "./serialize";

/**
 * A source's recent runs, newest first — the short history behind "why is this
 * figure from yesterday".
 *
 * `teamId` is a predicate and not a comment: without it any run id would read
 * any team's sync history. A source that is not this team's simply has no runs.
 */
export const listSyncRuns = async (params: {
  syncSourceId: string;
  teamId: string;
  limit?: number;
}): Promise<SyncRunResponse[]> => {
  const rows = await db
    .select()
    .from(collectionSyncRuns)
    .where(
      and(
        eq(collectionSyncRuns.syncSourceId, params.syncSourceId),
        eq(collectionSyncRuns.teamId, params.teamId),
      ),
    )
    .orderBy(desc(collectionSyncRuns.startedAt))
    .limit(
      Math.min(
        params.limit ?? SYNC_LIMITS.runHistoryLimit,
        SYNC_LIMITS.runHistoryLimit,
      ),
    );
  return rows.map(serializeSyncRun);
};
