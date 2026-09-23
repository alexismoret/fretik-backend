import { sql } from "drizzle-orm";
import db from "../../db";
import { alreadyExists, notFound, throwHttpError } from "../../lib/errors";
import { requestSyncRefresh } from "./request-refresh";

/**
 * "Yes, apply the orphan policy anyway."
 *
 * The other half of the floor. A run that would have orphaned most of a
 * collection refuses, ends `partial`, and leaves `full_resync_requested_at` and
 * the numbers behind it. This is the only thing that clears the refusal: it
 * stamps a confirmation the NEXT run reads, and that run walks everything and
 * applies the policy whatever the diff comes to.
 *
 * It refuses when nothing asked, deliberately. A confirmation is an answer to a
 * specific question — "the app answered with 30 of the 4 000 rows this
 * collection tracks" — and a stamp written with no question pending would sit
 * there arming the next run's floor against a diff nobody has seen.
 */
export const confirmFullResync = async (input: {
  sourceId: string;
  teamId: string;
  userId?: string | null;
}): Promise<{ enqueued: boolean }> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: input.sourceId, teamId: input.teamId },
    columns: { id: true, fullResyncRequestedAt: true },
  });
  if (source === undefined) {
    return throwHttpError(404, notFound("Sync source not found"));
  }
  if (source.fullResyncRequestedAt === null) {
    return throwHttpError(
      409,
      alreadyExists(
        "This source has not asked for a full resync. Confirming one would apply its orphan policy to a difference nobody has seen. Refresh it, and confirm if it stops again.",
      ),
    );
  }

  await db.execute(sql`
    UPDATE collection_sync_sources
       SET full_resync_confirmed_at = now()
     WHERE id = ${source.id}::uuid`);

  const outcome = await requestSyncRefresh({
    sourceId: source.id,
    teamId: input.teamId,
    trigger: "manual",
    ...(input.userId != null ? { userId: input.userId } : {}),
  });
  return { enqueued: outcome.enqueued };
};
