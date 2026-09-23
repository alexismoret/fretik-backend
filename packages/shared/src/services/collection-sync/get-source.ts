import db from "../../db";
import type { SyncSourceResponse } from "../../schemas/collection-sync";
import { loadLastRuns } from "./last-runs";
import { loadSyncSourceContext, serializeSyncSource } from "./serialize";

/**
 * One source, or `undefined` when it is not this team's — never a throw and
 * never a distinction between "gone" and "someone else's", which is the same
 * rule every other by-id read here follows.
 */
export const getSyncSource = async (params: {
  id: string;
  teamId: string;
}): Promise<SyncSourceResponse | undefined> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: params.id, teamId: params.teamId },
  });
  if (source === undefined) return undefined;
  const context = await loadSyncSourceContext([source], {
    lastRuns: await loadLastRuns([source.id]),
  });
  return serializeSyncSource(source, context);
};
