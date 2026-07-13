import { and, eq } from "drizzle-orm";
import db from "../../db";
import { workflows } from "../../db/schema";
import { deleteWorkflowSchedule } from "../../lib/trigger-client";
import type { WorkflowResponse, WorkflowStatus } from "../../schemas/workflows";
import { getWorkflowRow } from "./get";
import { serializeWorkflow } from "./serialize";
import type { WorkflowRequester } from "./visibility";

/**
 * Tear down a workflow's Trigger.dev schedule (if any) and set its status —
 * the shared transition behind `pauseWorkflow` (→ paused) and
 * `archiveWorkflow` (→ archived). Best-effort on the schedule delete: a
 * Trigger hiccup must not block the local state change (a dangling schedule
 * is harmless — its task re-checks the workflow status before firing a run).
 */
export const deactivateWorkflow = async (params: {
  id: string;
  teamId: string;
  status: Extract<WorkflowStatus, "paused" | "archived">;
  /** Why the workflow stopped, when not a plain manual pause (the circuit
   * breaker passes `circuit_breaker:<N>`). Omitted → cleared to NULL. */
  reason?: string | null;
  requester?: WorkflowRequester;
}): Promise<WorkflowResponse | undefined> => {
  const { id, teamId, status } = params;
  const row = await getWorkflowRow({ id, teamId, requester: params.requester });
  if (!row) return undefined;

  if (row.triggerScheduleId) {
    await deleteWorkflowSchedule(row.triggerScheduleId).catch(
      (error: unknown) => {
        console.warn(
          `[workflows.deactivate] schedule delete failed for ${row.triggerScheduleId ?? "?"}:`,
          error instanceof Error ? error.message : error,
        );
      },
    );
  }

  const [updated] = await db
    .update(workflows)
    .set({
      status,
      triggerScheduleId: null,
      pausedReason: params.reason ?? null,
    })
    .where(and(eq(workflows.id, id), eq(workflows.teamId, teamId)))
    .returning();
  return updated ? serializeWorkflow(updated) : undefined;
};
