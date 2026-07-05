import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { type Job, Worker } from "bullmq";
import {
  DREAMING_SWEEP_JOB,
  GC_DEMOTE_JOB,
  JOURNAL_SWEEP_JOB,
  MEMORY_MAINTENANCE_QUEUE,
} from "../queues/names";
import { runDreamingSweep } from "./dreaming";
import { runGcDemote } from "./gc-demote";
import { runJournalSweep } from "./journal-sweep";

/**
 * Scheduled-job dispatcher: one worker, concurrency 1, routing by job name.
 * Everything here must be FAST — the journal sweep repeats every 15s, so the
 * nightly jobs only trigger work owned elsewhere (dreaming fans out per-team
 * jobs; GC is chunked SQL).
 */

export const startMaintenanceWorker = (): Worker => {
  const worker = new Worker(
    MEMORY_MAINTENANCE_QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case JOURNAL_SWEEP_JOB: {
          const { swept } = await runJournalSweep();
          if (swept > 0) {
            console.info(
              `[journal-sweep] fanned out ${swept.toString()} events`,
            );
          }
          return;
        }
        case DREAMING_SWEEP_JOB: {
          const { teams } = await runDreamingSweep();
          console.info(`[dreaming] fanned out ${teams.toString()} team jobs`);
          return;
        }
        case GC_DEMOTE_JOB: {
          const { demoted } = await runGcDemote();
          console.info(
            `[gc-demote] demoted ${demoted.toString()} stale episodes`,
          );
          return;
        }
        default:
          console.warn(`[memory-maintenance] unknown job "${job.name}"`);
      }
    },
    { connection: createWorkerConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[memory-maintenance] job ${job?.name ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
