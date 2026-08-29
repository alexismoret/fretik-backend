import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import {
  runModelSync,
  type ModelSyncResult,
} from "@fretik/shared/services/model-registry/sync/run";
import { Worker, type Job } from "bullmq";
import { MODEL_SYNC_JOB, MODEL_SYNC_QUEUE } from "../queues/names";

/**
 * Nightly model sync — 00:30 UTC, ahead of the vector-reconcile chain.
 *
 * The pass itself lives in `@fretik/shared`: it re-reads the upstream
 * catalogues, re-derives every live-state row, quarantines what is corrupting,
 * disables what fails policy twice, and files an alert for each decision. This
 * file owns only the scheduling and the log line — a worker that re-implemented
 * any of that would be a second source of truth for what the fleet routes on.
 *
 * `runModelSync` does not throw for anything it can attribute: an upstream that
 * refuses to answer becomes `status: "failed"` with a reason in `stats.errors`,
 * and every row keeps yesterday's values. So a rejection reaching the worker is
 * an unexpected failure, and BullMQ's `attempts: 2` (declared with the
 * scheduler, in queues/schedulers.ts — retry policy is a job option, not a
 * worker one) is what handles it.
 */

/**
 * One pass, with its outcome on one line.
 *
 * Not silent on a clean pass, unlike the maintenance sweeps: this one rewrites
 * the routing table every night whether or not anything moved, and "it ran and
 * changed nothing" is the fact an operator needs when a model starts behaving
 * differently. `stats.errors` goes to `console.error` — a partial sync reports
 * `ok`-looking counts, and the errors are the only thing that says otherwise.
 */
export const runModelSyncSweep = async (): Promise<ModelSyncResult> => {
  const { status, stats } = await runModelSync();
  console.info(
    `[model-sync] ${status} — seen ${stats.modelsSeen.toString()} · updated ${stats.modelsUpdated.toString()} · candidates ${stats.candidatesAdded.toString()} · policy failures ${stats.policyFailures.toString()} · quarantines released ${stats.quarantinesReleased.toString()} · alerts ${stats.alerts.toString()}`,
  );
  for (const error of stats.errors) {
    console.error(`[model-sync] ${error}`);
  }
  return { status, stats };
};

export const startModelSyncWorker = (): Worker => {
  // Concurrency 1: the pass reads and rewrites every `model_live_state` row, so
  // two of them at once would race on the same rows for no gain — the queue
  // exists to keep the crawl off the maintenance worker, not to parallelise it.
  const worker = new Worker(
    MODEL_SYNC_QUEUE,
    async (job: Job) => {
      if (job.name !== MODEL_SYNC_JOB) {
        console.warn(`[model-sync] unknown job "${job.name}"`);
        return;
      }
      await runModelSyncSweep();
    },
    { connection: createWorkerConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[model-sync] job ${job?.name ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
