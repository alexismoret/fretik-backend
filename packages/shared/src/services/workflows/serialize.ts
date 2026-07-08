import type { Workflow, WorkflowRun } from "../../db/schema";
import type {
  WorkflowResponse,
  WorkflowRunResponse,
} from "../../schemas/workflows";

/**
 * Map a `workflows` row to its API DTO. The jsonb columns are already the
 * right shape (typed via `$type` from the shared schema), so this is a
 * field projection — no re-validation.
 */
export const serializeWorkflow = (row: Workflow): WorkflowResponse => ({
  id: row.id,
  teamId: row.teamId,
  organizationId: row.organizationId,
  userId: row.userId,
  name: row.name,
  description: row.description,
  icon: row.icon,
  color: row.color,
  status: row.status,
  triggerType: row.triggerType,
  triggerConfig: row.triggerConfig,
  playbook: row.playbook,
  autonomy: row.autonomy,
  modelProfileKey: row.modelProfileKey,
  limits: row.limits,
  pausedReason: row.pausedReason,
  createdByUserId: row.createdByUserId,
  lastRunAt: row.lastRunAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * The pending approval id lives in `lastTurnResult` (the turn that parked the
 * run), untyped jsonb — read it defensively and only while awaiting approval.
 */
const pendingApprovalId = (row: WorkflowRun): string | null => {
  if (row.status !== "needs_approval" || row.lastTurnResult === null) {
    return null;
  }
  const value = row.lastTurnResult.approvalRequestId;
  return typeof value === "string" ? value : null;
};

export const serializeWorkflowRun = (
  row: WorkflowRun,
): WorkflowRunResponse => ({
  id: row.id,
  workflowId: row.workflowId,
  status: row.status,
  triggerType: row.triggerType,
  triggerPayload: row.triggerPayload,
  conversationId: row.conversationId,
  triggerRunId: row.triggerRunId,
  taskStates: row.taskStates,
  turnCount: row.turnCount,
  usage: row.usage,
  outputSummary: row.outputSummary,
  outputs: row.outputs,
  error: row.error,
  approvalRequestId: pendingApprovalId(row),
  isTest: row.isTest,
  triggeredByUserId: row.triggeredByUserId,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  createdAt: row.createdAt,
});
