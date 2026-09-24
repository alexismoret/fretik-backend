import db from "@fretik/shared/db";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { recordDecisions } from "@fretik/shared/services/decisions/journal";
import { remoteEvaluator } from "@fretik/shared/services/decisions/remote";
import { resolveFactSheet } from "@fretik/shared/services/facts/resolve";
import { createFilteredWorkflowRun } from "@fretik/shared/services/workflows/create-filtered-run";
import { type Job, Worker } from "bullmq";
import {
  buildGateQuestions,
  GATE_POINT,
  gateJournalEntries,
  readGateVerdicts,
} from "../lib/workflow-gate";
import { buildTriggerPayload } from "../lib/workflow-trigger-matching";
import {
  WORKFLOW_GATE_QUEUE,
  WORKFLOW_RUN_CREATE_JOB,
  type WorkflowGateJobData,
} from "../queues/names";
import { getWorkflowTriggerQueue } from "../queues/queues";

/**
 * Consumes the gate queue: one job = one event, every workflow it matched,
 * one decision.
 *
 * It sits between the 15s sweep and the run-creation worker for the reason
 * that already keeps `createWorkflowRun` off the maintenance queue — it makes
 * a network call — and it does two things the sweep deliberately cannot:
 * resolve the event's fact sheet (a couple of indexed reads) and ask the
 * decision model whether each matched workflow's criterion is met.
 *
 * FAIL-OPEN IS THE WHOLE SAFETY ARGUMENT. Every path that is not a confident
 * "no" enqueues the run: a workflow with no criterion, a decision service
 * that is off or slow or broken, an answer that never arrived, a fact sheet
 * that came back empty because the document was deleted mid-flight. The worst
 * case of this entire feature is therefore the behaviour that shipped before
 * it — workflows fire on everything — and the only way to lose a launch is a
 * model that answered, confidently, that the firing was not this workflow's.
 * Even then the refusal is a visible `filtered` row with "run anyway" on it.
 *
 * A thrown job is safe: BullMQ retries it, and both outcomes are idempotent —
 * the create jobs carry their `wfrun-{wf}-{event}` ids and the filtered rows
 * hit the same partial unique index every event run shares.
 */

/** Modest: each job is a couple of reads plus one sub-second decision call. */
const WORKER_CONCURRENCY = 5;

export const startWorkflowGateWorker = (): Worker<WorkflowGateJobData> => {
  const worker = new Worker<WorkflowGateJobData>(
    WORKFLOW_GATE_QUEUE,
    async (job: Job<WorkflowGateJobData>) => {
      const { eventId, teamId, organizationId, workflowIds } = job.data;
      if (workflowIds.length === 0) return;

      const event = await db.query.domainEvents.findFirst({
        where: { id: eventId },
      });
      // The journal is append-only, so a missing event means the team was
      // deleted under us. Nothing to gate and nothing to run.
      if (!event) return;

      // Re-read the workflows: they may have been paused, archived or had
      // their criterion edited between the sweep and here. The create worker
      // re-checks `status` again before spending a Trigger.dev call; what
      // matters HERE is reading the criterion that is current, since a
      // criterion just cleared must stop gating immediately.
      const workflows = await db.query.workflows.findMany({
        where: { id: { in: workflowIds }, teamId, status: "active" },
      });
      if (workflows.length === 0) return;

      const sheet = await resolveFactSheet(event);
      const questions = buildGateQuestions(workflows);
      // The WHOLE sheet goes, plus the event type: the engine cuts it to the
      // point's allow-list and strips content when content may not leave.
      // That happens there, not here, so the same rule holds for every
      // caller — while the unredacted sheet still becomes the run's own
      // trigger payload, since a run is entitled to its team's content.
      const response =
        Object.keys(questions).length === 0
          ? null
          : await remoteEvaluator(
              {
                point: GATE_POINT,
                subject: { type: "domain_event", id: eventId },
                sessionId: `workflow-gate:${eventId}`,
                state: { ...sheet.facts, eventType: event.type },
                questions,
              },
              { teamId, organizationId },
            );

      const verdicts = readGateVerdicts(workflows, response, new Date());

      // Journaled BEFORE any run exists, so a label arriving from the run
      // ("run anyway", its outcome) always finds its row. Best-effort: a
      // journal failure never costs a launch.
      await recordDecisions(
        gateJournalEntries({ verdicts, eventId, teamId, organizationId }),
      );

      const byId = new Map(workflows.map((w) => [w.id, w]));
      const triggerPayload = buildTriggerPayload(event, sheet.facts);

      const allowed = verdicts.filter((v) => v.allowed);
      const refused = verdicts.filter((v) => !v.allowed);

      if (allowed.length > 0) {
        await getWorkflowTriggerQueue().addBulk(
          allowed.map((verdict) => ({
            name: WORKFLOW_RUN_CREATE_JOB,
            data: {
              workflowId: verdict.workflowId,
              teamId,
              sourceEventId: eventId,
              triggerPayload,
              ...(verdict.decision !== null
                ? { gateDecision: verdict.decision }
                : {}),
            },
            opts: {
              jobId: `wfrun-${verdict.workflowId}-${eventId}`,
              attempts: 3,
              backoff: { type: "exponential" as const, delay: 5_000 },
              removeOnComplete: { count: 500 },
              removeOnFail: { count: 500 },
            },
          })),
        );
      }

      for (const verdict of refused) {
        const workflow = byId.get(verdict.workflowId);
        if (!workflow || verdict.decision === null) continue;
        await createFilteredWorkflowRun({
          workflow,
          sourceEventId: eventId,
          triggerPayload,
          decision: verdict.decision,
        });
      }

      // One line per gated event, not per verdict: a bulk upload would
      // otherwise write a log line per file per workflow.
      if (refused.length > 0) {
        console.info(
          `[workflow-gate] event ${eventId}: ${allowed.length.toString()} allowed, ${refused.length.toString()} filtered`,
        );
      }
    },
    { connection: createWorkerConnection(), concurrency: WORKER_CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[workflow-gate] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
