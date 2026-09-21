import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { syncJobId } from "@fretik/shared/services/collection-sync/queue";
import { runSyncSource } from "@fretik/shared/services/collection-sync/run-source";
import { claimDueSyncSources } from "@fretik/shared/services/collection-sync/sweep";
import { type Job, Worker } from "bullmq";
import { intFromEnv } from "../lib/env";
import {
  EXTERNAL_SYNC_QUEUE,
  EXTERNAL_SYNC_RUN_JOB,
  type ExternalSyncJobData,
} from "../queues/names";
import { getExternalSyncQueue } from "../queues/queues";

/**
 * Collection sync — the worker that fills a collection (or a few of its
 * columns) from a connected app.
 *
 * WHY ITS OWN QUEUE, and not the maintenance queue. One run walks a third party
 * until it has every row, bounded at ten minutes (`SYNC_LIMITS.runBudgetMs`)
 * and routinely taking seconds to minutes — an Akanea read alone is 12-15 s per
 * call. The maintenance worker runs at concurrency 1 with the 15 s journal and
 * workflow-trigger sweeps on it, so a single sync would stop the memory
 * pipeline and every event-triggered workflow for as long as the app took to
 * answer. That is the same head-of-line argument `mcp-refresh` and
 * `collection-index-sweep` are isolated for, and it applies harder here because
 * the duration is a THIRD PARTY's, not ours.
 *
 * CONCURRENCY IS A KNOB, defaulting to 8, and the replicas multiply it. A run
 * spends better than nine tenths of its wall clock waiting on a third party —
 * an Akanea read alone is 12-15 s per call — so seats are cheap and the ceiling
 * that matters is somebody else's rate limit, which is the GOVERNOR's job and
 * not this number's (`exec/governor/`). Nor is per-connection serialisation:
 * the governor holds one seat for apps that declare themselves serial.
 *
 * What the old literal 3 was really protecting was the database, and the
 * streaming runner changed that argument: the writes are short transactions
 * bounded per page, and a stable source rewrites nothing at all. The number to
 * add the day N replicas × 8 start fifty first loads together is "max
 * simultaneous first loads", not a return to 3.
 *
 * JOB PRIORITY carries the fairness the claim computed: 1 for the first source
 * of any team, 2 for its second, and so on, so a team with three overdue syncs
 * cannot make another team wait behind all three. BullMQ serves the lowest
 * number first.
 *
 * One attempt per job, set by the producer. A failed run is recorded in
 * `collection_sync_runs`, moves `consecutive_failures` and feeds the source's
 * own exponential backoff; a BullMQ retry on top would ask a failing app twice
 * as often as the backoff just decided it should be asked.
 */

/** Runs one replica walks at once. Replicas multiply it; nothing caps the total. */
const CONCURRENCY = intFromEnv("EXTERNAL_SYNC_CONCURRENCY", 8);

/**
 * Claim every due source and hand each to the queue.
 *
 * The claim and the enqueue are deliberately in this order, and the jobs are
 * marked `preClaimed`: `claimDueSyncSources` is ONE `UPDATE … RETURNING` whose
 * own `WHERE` is the mutual exclusion, so two replicas sweeping in the same
 * second cannot both take a row. Enqueuing first and claiming in the worker
 * would move that race to a place where it is not atomic.
 */
export const runExternalSyncSweep = async (): Promise<{ claimed: number }> => {
  const due = await claimDueSyncSources();
  if (due.length === 0) return { claimed: 0 };

  await getExternalSyncQueue().addBulk(
    due.map((source) => ({
      name: EXTERNAL_SYNC_RUN_JOB,
      data: {
        sourceId: source.id,
        teamId: source.teamId,
        trigger: "schedule" as const,
        preClaimed: true,
      },
      opts: {
        // Same id a manual refresh uses: a source has ONE job at a time, and a
        // refresh pressed while the tick was landing collapses into it.
        jobId: syncJobId(source.id),
        // The claim's own per-team rank. Every team's first source runs before
        // any team's second.
        priority: source.rank,
        attempts: 1,
        // Both retentions delete immediately — BullMQ refuses an `add` whose
        // jobId exists in ANY state, so a kept job would lock the source out of
        // every later run until it aged out. The history lives in
        // `collection_sync_runs`, which survives a Redis flush.
        removeOnComplete: true,
        removeOnFail: true,
      },
    })),
  );
  return { claimed: due.length };
};

export const startExternalSyncWorker = (): Worker<ExternalSyncJobData> => {
  const worker = new Worker<ExternalSyncJobData>(
    EXTERNAL_SYNC_QUEUE,
    async (job: Job<ExternalSyncJobData>) => {
      if (job.name !== EXTERNAL_SYNC_RUN_JOB) {
        console.warn(`[external-sync] unknown job "${job.name}"`);
        return;
      }
      const result = await runSyncSource({
        sourceId: job.data.sourceId,
        trigger: job.data.trigger,
        ...(job.data.recordIds !== undefined
          ? { recordIds: job.data.recordIds }
          : {}),
        ...(job.data.triggeredByUserId != null
          ? { triggeredByUserId: job.data.triggeredByUserId }
          : {}),
        ...(job.data.preClaimed !== undefined
          ? { preClaimed: job.data.preClaimed }
          : {}),
        ...(job.data.continueFrom !== undefined
          ? { continueFrom: job.data.continueFrom }
          : {}),
      });
      if (result.status === "skipped") {
        // Not a failure and usually not even noteworthy: `already_running` is
        // the idempotency guard doing its job every time somebody double-clicks.
        return;
      }
      const counts = result.counts;
      console.info(
        `[external-sync] ${job.data.sourceId} ${result.status}` +
          (result.suspended === true
            ? ` (leg ${String(result.legs ?? 1)}${result.stopReason === undefined ? "" : `, ${result.stopReason}`})`
            : "") +
          (counts === undefined
            ? ""
            : ` · +${counts.createdCount.toString()} ~${counts.updatedCount.toString()} =${counts.unchangedCount.toString()} ✗${counts.failedCount.toString()} · ${counts.upstreamCalls.toString()} calls${counts.truncated ? " (truncated)" : ""}`) +
          (result.error === undefined ? "" : ` · ${result.error}`),
      );
    },
    { connection: createWorkerConnection(), concurrency: CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    // `runSyncSource` turns every failure it can attribute into a run row and
    // returns normally, so reaching here means something outside the run threw
    // — and the source may still be holding its claim until it expires.
    console.error(
      `[external-sync] job ${job?.data.sourceId ?? "<unknown>"} threw:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
