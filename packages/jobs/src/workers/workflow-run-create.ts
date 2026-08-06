import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { countRecentEventRuns } from "@fretik/shared/services/workflows/count-recent-event-runs";
import { createWorkflowRun } from "@fretik/shared/services/workflows/create-run";
import { eventRunExists } from "@fretik/shared/services/workflows/event-run-exists";
import { getWorkflowRow } from "@fretik/shared/services/workflows/get";
import { tripRunawayGuard } from "@fretik/shared/services/workflows/trip-runaway-guard";
import { type Job, Worker } from "bullmq";
import {
  WORKFLOW_TRIGGER_QUEUE,
  type WorkflowRunCreateJobData,
} from "../queues/names";

/**
 * Consumes the event-trigger queue: one job = create one run for a
 * (workflow, source event) pair. Kept off the 15s sweep because
 * `createWorkflowRun` calls Trigger.dev over the network. Idempotent by
 * contract — re-checks `eventRunExists` (job retention may lapse before the
 * unique index is the only guard) and re-reads the mutable workflow row (it
 * may have been paused/archived between enqueue and here).
 *
 * This is where the RUNAWAY GUARD lives: every matched event becomes a run
 * (the Trigger.dev per-workflow queue is the backpressure — a 500-file bulk
 * upload yields 500 `queued` runs, never a silent drop), but past
 * `WORKFLOW_EVENT_RUNS_PER_HOUR` created runs in an hour the workflow is
 * auto-paused LOUDLY (`pausedReason 'runaway:<cap>'`) and its queued event
 * backlog canceled. Created runs are committed and countable here, so the
 * guard is authoritative across sweeps.
 */

/** Modest fan-out: event runs are rare and each does one network call. */
const WORKER_CONCURRENCY = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** High on purpose: a legit 500-document upload must pass with margin. A
 * true runaway still trips fast — creation is quick, and execution stays
 * bounded by the per-workflow Trigger.dev concurrency until the pause. */
const runsPerHourCap = (): number => {
  const raw = Number.parseInt(
    process.env["WORKFLOW_EVENT_RUNS_PER_HOUR"] ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
};

export const startWorkflowRunCreateWorker =
  (): Worker<WorkflowRunCreateJobData> => {
    const worker = new Worker<WorkflowRunCreateJobData>(
      WORKFLOW_TRIGGER_QUEUE,
      async (job: Job<WorkflowRunCreateJobData>) => {
        const { workflowId, teamId, sourceEventId, triggerPayload } = job.data;

        if (await eventRunExists({ workflowId, sourceEventId })) return;

        const workflow = await getWorkflowRow({ id: workflowId, teamId });
        // Paused/archived (or deleted) since enqueue — drop it silently.
        // (This is also how a runaway pause neutralizes the jobs behind it.)
        if (!workflow || workflow.status !== "active") return;

        // Runaway guard — a storm can overshoot by at most the worker
        // concurrency before every remaining job hits the gate above.
        const cap = runsPerHourCap();
        const recent = await countRecentEventRuns({
          workflowId,
          since: new Date(Date.now() - ONE_HOUR_MS),
        });
        if (recent >= cap) {
          await tripRunawayGuard({ workflowId, teamId, cap });
          return;
        }

        await createWorkflowRun({
          workflow,
          triggerType: "event",
          triggerPayload,
          sourceEventId,
        });
      },
      { connection: createWorkerConnection(), concurrency: WORKER_CONCURRENCY },
    );
    worker.on("failed", (job, err) => {
      console.error(
        `[workflow-run-create] job ${job?.id ?? "<unknown>"} failed:`,
        err instanceof Error ? err.message : err,
      );
    });
    return worker;
  };
