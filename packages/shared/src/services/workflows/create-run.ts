import { eq } from "drizzle-orm";
import db from "../../db";
import { aiConversations, workflowRuns, type Workflow } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { triggerWorkflowRun } from "../../lib/trigger-client";
import { requiredRunFileInputs } from "../../schemas/workflow-triggers";
import type {
  WorkflowRunResponse,
  WorkflowTaskState,
  WorkflowTriggerType,
} from "../../schemas/workflows";
import { WORKFLOW_MAX_DURATION_MINUTES } from "../../schemas/workflows";
import { getTeamBotUserId } from "../auth/bot-user";
import { completeConversationTask } from "../conversation-tasks/complete";
import { registerConversationTask } from "../conversation-tasks/register";
import { attachRunFiles, type RunAttachment } from "./attach-run-files";
import { finalizeRun } from "./finalize-run";
import { sendRunCompletionEmailIfEnabled } from "./send-run-completion-email";
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
  /** Files handed to the run (a form submission's uploads) — stored on the
   * run's conversation as `ai_chat_files` so the agent reads them via
   * `<file_attachments>`. Written before the task fires. */
  attachments?: RunAttachment[];
  isTest?: boolean;
}): Promise<WorkflowRunResponse> => {
  const { workflow } = params;

  // A launch that dies at creation is reported to the launching turn inline —
  // that turn is still streaming. Settle AND consume the wait record so the
  // conversation is never woken for an error it already handled.
  const settleFailedLaunch = async (runId: string): Promise<void> => {
    if (!params.sourceConversationId) return;
    await completeConversationTask({
      kind: "workflow_run",
      ref: runId,
      status: "failed",
      consume: true,
    });
  };

  // Team workflows act as the team bot; user-scoped workflows act as their
  // owner. This identity feeds the sandbox JWT, journal attribution, and
  // recall's user-scope gating.
  const actingUserId =
    workflow.userId ?? (await getTeamBotUserId(workflow.teamId));

  const { runId, conversationId } = await db.transaction(async (tx) => {
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

    // A run launched from a chat is something that chat now waits on: record
    // it in the same transaction, so a run that exists is always tracked and
    // the conversation can be resumed when it (and its siblings) finish.
    if (params.sourceConversationId) {
      await registerConversationTask({
        tx,
        conversationId: params.sourceConversationId,
        kind: "workflow_run",
        ref: run.id,
        title: workflow.name,
        metadata: { workflowId: workflow.id, isTest: params.isTest ?? false },
      });
    }

    return { runId: run.id, conversationId: conversation.id };
  });

  // Fail fast when the trigger's required file inputs are absent (per-kind
  // contract in the trigger registry) — the executor would otherwise start
  // against an empty `attachments/` and can only improvise. Triggers that
  // collect files (form submissions, future connector mailboxes) always pass
  // validated attachments; this is the mechanical backstop for builder test
  // runs and API launches.
  const missingFileInputs = params.attachments?.length
    ? []
    : requiredRunFileInputs(workflow.triggerType, workflow.triggerConfig);
  if (missingFileInputs.length > 0) {
    const { transitioned } = await finalizeRun({
      runId,
      status: "failed",
      error: {
        code: "INPUT_MISSING",
        message: `This workflow's trigger requires file input(s) (${missingFileInputs.join(", ")}), but the run received none.`,
      },
    });
    if (transitioned) {
      void sendRunCompletionEmailIfEnabled({ runId }).catch((err: unknown) => {
        console.warn(`[workflow-run ${runId}] completion email failed:`, err);
      });
    }
    await settleFailedLaunch(runId);
    const row = await db.query.workflowRuns.findFirst({
      where: { id: runId },
    });
    if (!row) return throwHttpError(500, internalError());
    return serializeWorkflowRun(row);
  }

  // Store any trigger files on the run's conversation BEFORE the task fires,
  // so the first turn sees them in `<file_attachments>` (S3 write is a network
  // call — kept out of the DB transaction).
  if (params.attachments?.length) {
    await attachRunFiles(conversationId, params.attachments);
  }

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
    // Close through `finalizeRun` (not a direct UPDATE) so this terminal path
    // journals `workflow.run.completed` and notifies like every other one.
    const { transitioned } = await finalizeRun({
      runId,
      status: "failed",
      error: { code: "TRIGGER_FAILED", message },
    });
    if (transitioned) {
      void sendRunCompletionEmailIfEnabled({ runId }).catch((err: unknown) => {
        console.warn(`[workflow-run ${runId}] completion email failed:`, err);
      });
    }
    await settleFailedLaunch(runId);
    const row = await db.query.workflowRuns.findFirst({
      where: { id: runId },
    });
    if (!row) return throwHttpError(500, internalError());
    return serializeWorkflowRun(row);
  }
};
