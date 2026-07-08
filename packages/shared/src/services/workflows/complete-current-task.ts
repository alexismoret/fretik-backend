import { eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import {
  currentWorkflowTask,
  type WorkflowTaskState,
} from "../../schemas/workflows";

export interface CompleteCurrentTaskResult {
  /** The task that was just closed (fresh state), or null when there was
   * no open task (all already terminal — a duplicate call). */
  completed: WorkflowTaskState | null;
  /** The next task, already stamped `in_progress`, or null when none left. */
  next: WorkflowTaskState | null;
  /** True when every task is now terminal — the run can conclude. */
  allDone: boolean;
  taskStates: WorkflowTaskState[];
}

/**
 * The `completeTask` tool's write path: close the CURRENT task (the cursor —
 * no key taken from the model, so it can never close the wrong one), then
 * advance: stamp the next pending task `in_progress` and return it so the
 * tool result carries its instructions (the agent chains tasks within one
 * turn). `fatal` skips every remaining task — the run concludes now.
 *
 * Row-locked like `startCurrentTask`: cursor moves are sequential (one turn
 * per run), the lock guards retry races. A call with no open task is a
 * harmless no-op (duplicate tool call) — returns the current terminal state.
 */
export const completeCurrentTask = async (params: {
  runId: string;
  outcome: "completed" | "skipped" | "failed";
  summary?: string;
  fatal?: boolean;
  now?: Date;
}): Promise<CompleteCurrentTaskResult> =>
  db.transaction(async (tx) => {
    const [run] = await tx
      .select({ taskStates: workflowRuns.taskStates })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, params.runId))
      .for("update");
    if (!run) {
      return { completed: null, next: null, allDone: false, taskStates: [] };
    }

    const nowIso = (params.now ?? new Date()).toISOString();
    const current = currentWorkflowTask(run.taskStates);
    if (!current) {
      return {
        completed: null,
        next: null,
        allDone: true,
        taskStates: run.taskStates,
      };
    }

    const closed: WorkflowTaskState = {
      ...current,
      status: params.outcome,
      finishedAt: nowIso,
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
    };

    let advanced = false;
    let next: WorkflowTaskState | null = null;
    const taskStates = run.taskStates.map((t): WorkflowTaskState => {
      if (t.key === current.key) return closed;
      if (t.status !== "pending") return t;
      if (params.fatal) {
        return { ...t, status: "skipped", finishedAt: nowIso };
      }
      if (!advanced) {
        advanced = true;
        next = { ...t, status: "in_progress", startedAt: nowIso };
        return next;
      }
      return t;
    });

    await tx
      .update(workflowRuns)
      .set({ taskStates })
      .where(eq(workflowRuns.id, params.runId));

    return {
      completed: closed,
      next,
      allDone: next === null,
      taskStates,
    };
  });
