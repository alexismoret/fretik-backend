import { sql } from "drizzle-orm";
import db from "../../db";
import type { CollectionSyncRunTrigger } from "../../db/schema";
import { MAX_BULK_ITEMS } from "../../lib/db-bulk";
import {
  EXTERNAL_SYNC_RUN_JOB,
  getExternalSyncQueue,
  syncJobId,
} from "./queue";
import { markRecordsPending } from "./record-state";

/**
 * "Refresh this now" — the one entry point behind the button, the agent's
 * `manageSync refresh`, and the collection-open path.
 *
 * Idempotent by construction, because all three fire at once in normal use: a
 * person opens a stale collection (which asks), sees the banner and presses
 * Refresh (which asks again) while the scheduled tick lands (a third). The job
 * id is the source's, so BullMQ collapses them into one queued job; and the
 * runner claims the source row before it starts, so a job that arrives while a
 * run is in flight is dropped rather than doubling it.
 *
 * What is NOT dropped is the record-level request. `recordIds` are marked
 * `pending` in `record_sync_state` BEFORE the enqueue, so even the job that
 * collapses leaves its work behind for whichever run comes next — a refresh
 * request survives a Redis restart, a duplicate job and a run already under
 * way, because the durable signal is a row and not a job.
 */

export type RequestRefreshOutcome =
  | { enqueued: true; jobId: string }
  | {
      enqueued: false;
      reason: "not_found" | "disabled" | "fresh_enough" | "no_connection";
    };

export const requestSyncRefresh = async (input: {
  sourceId: string;
  teamId: string;
  trigger: CollectionSyncRunTrigger;
  /** `lookup` only — refresh these records first. */
  recordIds?: string[];
  /** Who pressed the button, for the run row. */
  userId?: string | null;
  /**
   * `open` only — ask only when the data is older than this. Applied here
   * rather than at the call site so every surface that opens a collection gets
   * the same answer, and so a tab left open cannot poll an app by re-rendering.
   */
  onlyIfOlderThanMinutes?: number;
}): Promise<RequestRefreshOutcome> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: input.sourceId, teamId: input.teamId },
    columns: {
      id: true,
      kind: true,
      enabled: true,
      connectionId: true,
      lastSuccessAt: true,
    },
  });
  if (source === undefined) return { enqueued: false, reason: "not_found" };
  if (!source.enabled) return { enqueued: false, reason: "disabled" };
  // A source whose connection was deleted has nothing to read through. Saying
  // so here keeps a run row from being written for a failure we already know.
  if (source.connectionId === null) {
    return { enqueued: false, reason: "no_connection" };
  }

  if (input.onlyIfOlderThanMinutes !== undefined) {
    const staleAfterMs = input.onlyIfOlderThanMinutes * 60_000;
    const age =
      source.lastSuccessAt === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - source.lastSuccessAt.getTime();
    if (age < staleAfterMs) return { enqueued: false, reason: "fresh_enough" };
  }

  if (input.recordIds !== undefined && input.recordIds.length > 0) {
    await markRecordsPending(
      source.id,
      input.recordIds.slice(0, MAX_BULK_ITEMS),
    );
  }

  // The durable backstop: if Redis loses the job, the minute-ly sweep still
  // picks the source up. Only when nothing holds the claim — overwriting
  // `next_run_at` under a running source would be undone by `scheduleNextRun`
  // the moment that run ends, and the `pending` rows above already carry the
  // request across.
  await db.execute(sql`
    UPDATE collection_sync_sources
       SET next_run_at = now()
     WHERE id = ${source.id}::uuid
       AND claimed_at IS NULL`);

  const jobId = syncJobId(source.id);
  await getExternalSyncQueue().add(
    EXTERNAL_SYNC_RUN_JOB,
    {
      sourceId: source.id,
      teamId: input.teamId,
      trigger: input.trigger,
      ...(input.recordIds !== undefined && input.recordIds.length > 0
        ? { recordIds: input.recordIds.slice(0, MAX_BULK_ITEMS) }
        : {}),
      ...(input.userId != null ? { triggeredByUserId: input.userId } : {}),
    },
    {
      jobId,
      // Ahead of every scheduled tick. The sweep hands its jobs the source's
      // per-team rank (1, 2, 3 …); a refresh is somebody watching a screen, so
      // it takes the top of that same scale rather than queueing behind
      // another team's second and third sources.
      priority: 1,
      // One attempt. A failed run is not a lost one: it is recorded in
      // `collection_sync_runs`, it moved `consecutive_failures`, and the source
      // already carries its own backoff — a BullMQ retry on top would ask a
      // failing third party twice as often as the backoff decided.
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
  return { enqueued: true, jobId };
};
