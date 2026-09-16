import { sql } from "drizzle-orm";
import db from "../../db";
import type {
  CollectionSyncRunStatus,
  CollectionSyncRunTrigger,
} from "../../db/schema";
import { collectionSyncRuns } from "../../db/schema";
import { SYNC_LIMITS } from "../../schemas/collection-sync";
import { resolveSyncAction } from "./resolve-action";
import { runLookupSync } from "./run-lookup-sync";
import {
  emptyCounts,
  runTableSync,
  type SyncRunCounts,
} from "./run-table-sync";
import { claimSyncSource, scheduleNextRun } from "./sweep";

/**
 * One run, start to finish — the only thing the worker calls.
 *
 * It owns the lifecycle and nothing else: claim the source so two replicas
 * cannot run it at once, open a `collection_sync_runs` row, hand the work to
 * the `table` or `lookup` runner, and close both the run and the source's
 * schedule whatever happened. The two runners never touch either.
 *
 * A failure is a VALUE here, never a thrown exception escaping to BullMQ. The
 * run row is the history a person reads, the source's `lastError` is what the
 * banner shows, and `consecutiveFailures` is what eventually pauses a source
 * whose app has been refusing for a day. A job that threw would leave all three
 * unwritten and the source claimed until the claim expired.
 */

export type SyncRunOutcomeStatus = CollectionSyncRunStatus | "skipped";

export interface RunSyncSourceResult {
  status: SyncRunOutcomeStatus;
  runId?: string;
  counts?: SyncRunCounts;
  error?: string;
  /** Present when nothing ran, so the worker's log says why. */
  skippedReason?: "not_found" | "disabled" | "already_running";
}

export const runSyncSource = async (input: {
  sourceId: string;
  trigger: CollectionSyncRunTrigger;
  recordIds?: string[];
  triggeredByUserId?: string | null;
  /** The sweep already holds the claim — see `ExternalSyncJobData`. */
  preClaimed?: boolean;
}): Promise<RunSyncSourceResult> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: input.sourceId },
  });
  if (source === undefined) {
    return { status: "skipped", skippedReason: "not_found" };
  }
  if (!source.enabled) {
    return { status: "skipped", skippedReason: "disabled" };
  }
  if (input.preClaimed !== true && !(await claimSyncSource(source.id))) {
    // A run is already under way. THIS is what makes "Refresh" idempotent
    // however many times it is pressed, and what keeps a scheduled tick from
    // doubling a manual refresh.
    return { status: "skipped", skippedReason: "already_running" };
  }

  const [run] = await db
    .insert(collectionSyncRuns)
    .values({
      syncSourceId: source.id,
      teamId: source.teamId,
      status: "running",
      trigger: input.trigger,
      triggeredByUserId: input.triggeredByUserId ?? null,
    })
    .returning({ id: collectionSyncRuns.id });
  const runId = run?.id;

  const startedAt = Date.now();
  let counts: SyncRunCounts = emptyCounts();
  let status: CollectionSyncRunStatus = "success";
  let error: string | undefined;

  try {
    const connection =
      source.connectionId === null
        ? undefined
        : await db.query.externalAppConnections.findFirst({
            where: { id: source.connectionId, teamId: source.teamId },
          });
    if (connection === undefined) {
      throw new Error(
        "the connection this source reads through is gone — reconnect the app and the data is picked up again; nothing stored has been lost",
      );
    }
    const resolved = await resolveSyncAction(connection, source.operation);
    if (!resolved.ok) throw new Error(resolved.message);

    const deadlineAt = startedAt + SYNC_LIMITS.runBudgetMs;
    counts =
      source.kind === "table"
        ? await runTableSync({ source, action: resolved.action, deadlineAt })
        : await runLookupSync({
            source,
            connection,
            action: resolved.action,
            deadlineAt,
            ...(input.recordIds !== undefined
              ? { recordIds: input.recordIds }
              : {}),
          });
    // `partial` is the honest word for both shapes of incomplete: rows that
    // failed, and a walk that stopped at a bound. They are reported the same
    // way because they mean the same thing to a reader — what is on screen is
    // not all of it.
    status = counts.failedCount > 0 || counts.truncated ? "partial" : "success";
  } catch (cause) {
    status = "failed";
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (runId !== undefined) {
    await db.execute(sql`
      UPDATE collection_sync_runs
         SET status = ${status}::collection_sync_run_status,
             finished_at = now(),
             created_count = ${counts.createdCount},
             updated_count = ${counts.updatedCount},
             unchanged_count = ${counts.unchangedCount},
             orphan_count = ${counts.orphanCount},
             failed_count = ${counts.failedCount},
             upstream_calls = ${counts.upstreamCalls},
             truncated = ${counts.truncated},
             error = ${error ?? null}
       WHERE id = ${runId}::uuid`);
  }

  // `lastSuccessAt` moves ONLY on a clean run, and that is a correctness rule
  // rather than bookkeeping: it is the lower bound an incremental read binds
  // (`{"$since": true}`), so stamping it after a truncated pass would make the
  // next run ask for "everything since now" and silently skip every row the
  // bound cut off.
  await scheduleNextRun(source, {
    ok: status !== "failed",
    ...(error !== undefined ? { error } : {}),
    ...(status === "success" ? { succeededAt: new Date() } : {}),
  });

  await trimRunHistory(source.id);

  return {
    status,
    ...(runId !== undefined ? { runId } : {}),
    counts,
    ...(error !== undefined ? { error } : {}),
  };
};

/**
 * Keep the latest runs and drop the rest — the retention `page_versions` and
 * `ai_memory_history` already use. Post-insert rather than on a sweep because
 * the only moment a source's history can grow is the moment it just did.
 */
const trimRunHistory = async (syncSourceId: string): Promise<void> => {
  await db.execute(sql`
    DELETE FROM collection_sync_runs
     WHERE sync_source_id = ${syncSourceId}::uuid
       AND id NOT IN (
         SELECT id FROM collection_sync_runs
          WHERE sync_source_id = ${syncSourceId}::uuid
          ORDER BY started_at DESC
          LIMIT ${SYNC_LIMITS.runHistoryLimit}
       )`);
};
