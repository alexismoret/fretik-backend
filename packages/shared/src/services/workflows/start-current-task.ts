import { eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import {
  currentWorkflowTask,
  type WorkflowTaskState,
} from "../../schemas/workflows";

/**
 * Harness-side task-cursor stamp, called by the turn handler BEFORE the
 * model runs: the current task (first in_progress, else first pending) is
 * marked `in_progress` deterministically — the timeline's "started" edge
 * never depends on the model remembering to report it. Returns the current
 * task (fresh state), or null when every task is terminal (run is done).
 *
 * Row-locked read-modify-write: cursor moves are sequential by design (one
 * turn at a time per run), the lock guards the rare overlap (retry races).
 */
export const startCurrentTask = async (params: {
  runId: string;
  now?: Date;
}): Promise<WorkflowTaskState | null> =>
  db.transaction(async (tx) => {
    const [run] = await tx
      .select({ taskStates: workflowRuns.taskStates })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, params.runId))
      .for("update");
    if (!run) return null;

    const current = currentWorkflowTask(run.taskStates);
    if (!current) return null;
    if (current.status === "in_progress") return current;

    const startedAt = (params.now ?? new Date()).toISOString();
    const started: WorkflowTaskState = {
      ...current,
      status: "in_progress",
      startedAt,
    };
    await tx
      .update(workflowRuns)
      .set({
        taskStates: run.taskStates.map((t) =>
          t.key === current.key ? started : t,
        ),
      })
      .where(eq(workflowRuns.id, params.runId));
    return started;
  });
