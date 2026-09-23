import db from "../../db";
import type { SyncSourceResponse } from "../../schemas/collection-sync";
import { loadLastRuns } from "./last-runs";
import { loadSyncSourceContext, serializeSyncSource } from "./serialize";

/**
 * Every source of a team, or of one collection — the list endpoint and the
 * collection header both read this.
 *
 * Fixed number of queries whatever the count: one for the sources, one for
 * their runs, one for the connections, and one MCP snapshot per distinct MCP
 * connection. Serializing one at a time would be four reads PER SOURCE, and a
 * settings page listing a dozen is exactly where that shows.
 */
export const listSyncSources = async (params: {
  teamId: string;
  collectionId?: string;
}): Promise<SyncSourceResponse[]> => {
  const sources = await db.query.collectionSyncSources.findMany({
    where: {
      teamId: params.teamId,
      ...(params.collectionId !== undefined
        ? { collectionId: params.collectionId }
        : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (sources.length === 0) return [];
  const context = await loadSyncSourceContext(sources, {
    lastRuns: await loadLastRuns(sources.map((source) => source.id)),
  });
  return sources.map((source) => serializeSyncSource(source, context));
};
