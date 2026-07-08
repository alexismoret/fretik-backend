import { eq } from "drizzle-orm";
import db from "../../db";
import { aiConversations, workflowRuns, type Workflow } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { triggerWorkflowRun } from "../../lib/trigger-client";
import type {
  WorkflowRunResponse,
  WorkflowTaskState,
  WorkflowTriggerType,
} from "../../schemas/workflows";
import { WORKFLOW_MAX_DURATION_MINUTES } from "../../schemas/workflows";
import { getTeamBotUserId } from "../auth/bot-user";
import { serializeWorkflowRun } from "./serialize";

/**
 * Snapshot the workflow's playbook into the run's initial task states —
 * every task starts `pending`, instructions included. Taken at run creation
 * so editing the workflow never mutates an in-flight or historical run, and
 * so the turn handler + `completeTask` tool read everything from the run row.
 */
const snapshotTaskStates = (workflow: Workflow): WorkflowTaskState[] =>
  workflow.playbook.tasks.map((task) => ({
    key: task.key,
    title: task.title,
    description: task.description,
    instructions: task.instructions,
    ...(task.expectedOutput !== undefined
      ? { expectedOutput: task.expectedOutput }
      : {}),
    ...(task.toolHints !== undefined ? { toolHints: task.toolHints } : {}),
    status: "pending" as const,
  }));

/**
 * THE single seam that creates a run and hands it to Trigger.dev — shared by
 * the manual API route, the cron proxy, the event sweep, and the chatbot
 * builder's test runs. Resolves the acting identity (`workflow.userId ??
 * teamSettings.botUserId`), creates the run's dedicated `agent_type:
 * "workflow"` conversation + the run row in one transaction, then triggers
 * the orchestrator task and stamps `triggerRunId`.
 */
export const createWorkflowRun = async (params: {
  workflow: Workflow;
  triggerType: WorkflowTriggerType;
  triggerPayload?: Record<string, unknown>;
  triggeredByUserId?: string | null;
  sourceEventId?: string | null;
  /** The CHAT conversation that launched this run (builder `run_test`), so the
   * run posts its completion notice back there. NULL for cron/event/API runs. */
  sourceConversationId?: string | null;
  isTest?: boolean;
}): Promise<WorkflowRunResponse> => {
  const { workflow } = params;

  // Team workflows act as the team bot; user-scoped workflows act as their
  // owner. This identity feeds the sandbox JWT, journal attribution, and
  // recall's user-scope gating.
  const actingUserId =
    workflow.userId ?? (await getTeamBotUserId(workflow.teamId));

  const runId = await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(aiConversations)
      .values({
        organizationId: workflow.organizationId,
        teamId: workflow.teamId,
        userId: actingUserId,
        agentType: "workflow",
        title: workflow.name,
        modelProfileKey: workflow.modelProfileKey,
      })
      .returning({ id: aiConversations.id });
    if (!conversation) return throwHttpError(500, internalError());

    const [run] = await tx
      .insert(workflowRuns)
      .values({
        workflowId: workflow.id,
        organizationId: workflow.organizationId,
        teamId: workflow.teamId,
        actingUserId,
        triggeredByUserId: params.triggeredByUserId ?? null,
        status: "queued",
        triggerType: params.triggerType,
        triggerPayload: params.triggerPayload ?? {},
        sourceEventId: params.sourceEventId ?? null,
        sourceConversationId: params.sourceConversationId ?? null,
        conversationId: conversation.id,
        taskStates: snapshotTaskStates(workflow),
        isTest: params.isTest ?? false,
      })
      .returning({ id: workflowRuns.id });
    if (!run) return throwHttpError(500, internalError());
    return run.id;
  });

  // Hand off to Trigger.dev outside the DB transaction (a network call must
  // not hold a row lock). On failure, mark the run failed so it never hangs
  // in `queued` — the frontend then shows a clear error instead of a zombie.
  try {
    const { runId: triggerRunId } = await triggerWorkflowRun(
      {
        runId,
        workflowId: workflow.id,
        teamId: workflow.teamId,
        maxDurationMinutes:
          workflow.limits.maxDurationMinutes ?? WORKFLOW_MAX_DURATION_MINUTES,
      },
      { idempotencyKey: `workflow-run:${runId}` },
    );
    const [row] = await db
      .update(workflowRuns)
      .set({ triggerRunId })
      .where(eq(workflowRuns.id, runId))
      .returning();
    if (!row) return throwHttpError(500, internalError());
    return serializeWorkflowRun(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "trigger failed";
    const [row] = await db
      .update(workflowRuns)
      .set({
        status: "failed",
        error: { code: "TRIGGER_FAILED", message },
        finishedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId))
      .returning();
    if (!row) return throwHttpError(500, internalError());
    return serializeWorkflowRun(row);
  }
};
