import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { sweepConversationTasks } from "@fretik/shared/services/conversation-tasks/sweep";
import { markStalledRuns } from "@fretik/shared/services/workflows/mark-stalled-runs";
import { type Job, Worker } from "bullmq";
import {
  CONVERSATION_TASK_SWEEP_JOB,
  DREAMING_SWEEP_JOB,
  GC_DEMOTE_JOB,
  JOURNAL_SWEEP_JOB,
  MEMORY_MAINTENANCE_QUEUE,
  WORKFLOW_STALL_SWEEP_JOB,
  WORKFLOW_TRIGGER_SWEEP_JOB,
} from "../queues/names";
import { runDreamingSweep } from "./dreaming";
import { runGcDemote } from "./gc-demote";
import { runJournalSweep } from "./journal-sweep";
import { runWorkflowTriggerSweep } from "./workflow-trigger-sweep";

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
          const { demoted, purged } = await runGcDemote();
          console.info(
            `[gc-demote] demoted ${demoted.toString()} stale episodes, purged ${purged.toString()} expired`,
          );
          return;
        }
        case WORKFLOW_TRIGGER_SWEEP_JOB: {
          const { created } = await runWorkflowTriggerSweep();
          if (created > 0) {
            console.info(
              `[workflow-trigger-sweep] enqueued ${created.toString()} event runs`,
            );
          }
          return;
        }
        case WORKFLOW_STALL_SWEEP_JOB: {
          const reclaimed = await markStalledRuns();
          if (reclaimed > 0) {
            console.info(
              `[workflow-stall-sweep] reclaimed ${reclaimed.toString()} stalled runs`,
            );
          }
          return;
        }
        case CONVERSATION_TASK_SWEEP_JOB: {
          const { reconciled, signaled } = await sweepConversationTasks();
          if (reconciled > 0 || signaled > 0) {
            console.info(
              `[conversation-task-sweep] reconciled ${reconciled.toString()} tasks, signaled ${signaled.toString()} conversations`,
            );
          }
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
