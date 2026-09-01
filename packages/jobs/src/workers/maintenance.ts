import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { sweepConversationTasks } from "@fretik/shared/services/conversation-tasks/sweep";
import { runTelemetryRollup } from "@fretik/shared/services/model-registry/telemetry-rollup";
import { markStalledRuns } from "@fretik/shared/services/workflows/mark-stalled-runs";
import { type Job, Worker } from "bullmq";
import {
  CONVERSATION_TASK_SWEEP_JOB,
  DREAMING_SWEEP_JOB,
  GC_DEMOTE_JOB,
  JOURNAL_SWEEP_JOB,
  MEMORY_MAINTENANCE_QUEUE,
  MODEL_ALERT_SWEEP_JOB,
  MODEL_TELEMETRY_ROLLUP_JOB,
  WORKFLOW_STALL_SWEEP_JOB,
  WORKFLOW_TRIGGER_SWEEP_JOB,
} from "../queues/names";
import { runDreamingSweep } from "./dreaming";
import { runGcDemote } from "./gc-demote";
import { runJournalSweep } from "./journal-sweep";
import { runModelAlertSweep } from "./model-alert-sweep";
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
          const { reconciled, signaled, slotsCleared } =
            await sweepConversationTasks();
          if (reconciled > 0 || signaled > 0 || slotsCleared > 0) {
            console.info(
              `[conversation-task-sweep] reconciled ${reconciled.toString()} tasks, signaled ${signaled.toString()} conversations, cleared ${slotsCleared.toString()} stuck slots`,
            );
          }
          return;
        }
        case MODEL_ALERT_SWEEP_JOB: {
          const { delivered } = await runModelAlertSweep();
          if (delivered > 0) {
            console.info(
              `[model-alert-sweep] delivered ${delivered.toString()} alerts in one digest`,
            );
          }
          return;
        }
        case MODEL_TELEMETRY_ROLLUP_JOB: {
          const stats = await runTelemetryRollup();
          // Silent on an idle hour, like its neighbours. The errors are not
          // silent: an unparseable key or a failed insert means measurements
          // are being dropped, and the counters they came from expire in 48 h.
          if (stats.rowsWritten > 0 || stats.rowsPurged > 0) {
            console.info(
              `[model-telemetry-rollup] folded ${stats.rowsWritten.toString()} bucket(s), purged ${stats.rowsPurged.toString()} expired row(s)`,
            );
          }
          for (const error of stats.errors) {
            console.error(`[model-telemetry-rollup] ${error}`);
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
