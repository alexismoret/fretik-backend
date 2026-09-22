import type {
  WorkflowActiveRun,
  WorkflowRunPressure,
} from "../../schemas/workflows";

/**
 * Group a team's non-terminal runs into per-workflow pressure.
 *
 * Pure on purpose: the rows already come from `listActiveWorkflowRuns`, which
 * owns the one indexed `(teamId, status)` query AND the visibility predicate,
 * so every caller that needs counts reuses that read instead of adding a
 * second query shape with its own scoping bug.
 *
 * Test runs are counted like any other. A parked test run holds a slot and
 * blocks the next real one exactly the same way, so excluding it would report
 * a workflow as free while it is not.
 */
/** `isoDate` is `string | Date` on the wire — compare instants, not values. */
const instant = (value: string | Date): number => new Date(value).getTime();

export const summarizeRunPressure = (
  runs: WorkflowActiveRun[],
): Map<string, WorkflowRunPressure> => {
  const byWorkflow = new Map<string, WorkflowRunPressure>();

  for (const run of runs) {
    const current = byWorkflow.get(run.workflowId) ?? {
      running: 0,
      queued: 0,
      needsApproval: 0,
      waitingSince: null,
    };

    switch (run.status) {
      case "running":
        current.running += 1;
        break;
      case "queued":
        current.queued += 1;
        break;
      case "needs_approval": {
        current.needsApproval += 1;
        // `pausedAt` is when this run asked. Keep the EARLIEST across the
        // workflow: the age of the oldest unanswered question is what says
        // how long the workflow has been stuck, and it is the number a
        // person acts on.
        const askedAt = run.pausedAt ?? run.createdAt;
        if (
          current.waitingSince === null ||
          instant(askedAt) < instant(current.waitingSince)
        ) {
          current.waitingSince = askedAt;
        }
        break;
      }
      default:
        // Terminal statuses never reach here — `listActiveWorkflowRuns`
        // selects only the three above. Ignore rather than throw: a new
        // non-terminal status must not break the hub.
        break;
    }

    byWorkflow.set(run.workflowId, current);
  }

  return byWorkflow;
};

/** The zero value, so a caller can render a workflow with no active run. */
export const emptyRunPressure = (): WorkflowRunPressure => ({
  running: 0,
  queued: 0,
  needsApproval: 0,
  waitingSince: null,
});
