import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { countRecentEventRuns } from "@fretik/shared/services/workflows/count-recent-event-runs";
import { createWorkflowRun } from "@fretik/shared/services/workflows/create-run";
import { eventRunExists } from "@fretik/shared/services/workflows/event-run-exists";
import { getWorkflowRow } from "@fretik/shared/services/workflows/get";
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
 * This is the AUTHORITATIVE rate-cap point: the sweep's per-batch budget can't
 * see runs that later sweeps enqueue, so the storm is only truly bounded here,
 * where created runs are already committed and countable.
 */

/** Modest fan-out: event runs are rare and each does one network call. */
const WORKER_CONCURRENCY = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;

const runsPerHourCap = (): number => {
  const raw = Number.parseInt(
    process.env["WORKFLOW_EVENT_RUNS_PER_HOUR"] ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
};

export const startWorkflowRunCreateWorker =
  (): Worker<WorkflowRunCreateJobData> => {
    const worker = new Worker<WorkflowRunCreateJobData>(
      WORKFLOW_TRIGGER_QUEUE,
      async (job: Job<WorkflowRunCreateJobData>) => {
        const { workflowId, teamId, sourceEventId, triggerPayload } = job.data;

        if (await eventRunExists({ workflowId, sourceEventId })) return;

        // Authoritative rate cap — bounds the storm across sweeps (~cap +
        // in-flight worker concurrency in the worst case, which is fine).
        const recent = await countRecentEventRuns({
          workflowId,
          since: new Date(Date.now() - ONE_HOUR_MS),
        });
        if (recent >= runsPerHourCap()) {
          console.warn(
            `[workflow-run-create] rate cap reached for workflow ${workflowId} — dropping event ${sourceEventId}`,
          );
          return;
        }

        const workflow = await getWorkflowRow({ id: workflowId, teamId });
        // Paused/archived (or deleted) since enqueue — drop it silently.
        if (!workflow || workflow.status !== "active") return;

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
