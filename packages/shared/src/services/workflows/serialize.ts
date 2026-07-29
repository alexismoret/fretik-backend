import type { Workflow, WorkflowRun } from "../../db/schema";
import {
  WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS,
  WORKFLOW_MAX_DURATION_MINUTES,
  type WorkflowResponse,
  type WorkflowRunResponse,
} from "../../schemas/workflows";

/**
 * Absolute, shareable URL to a form workflow's public page, derived from its
 * token + the app origin (`APP_URL`, the same env the invitation links use).
 * Null when there's no token (non-form workflows) or no configured origin.
 */
const buildFormUrl = (token: string | null): string | null => {
  if (!token) return null;
  const appUrl = process.env.APP_URL;
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, "")}/f/${token}`;
};

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
  reasoningLevel: row.reasoningLevel,
  limits: row.limits,
  notifications: row.notifications,
  defaultLimits: {
    maxTotalTokens: WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS,
    maxDurationMinutes: WORKFLOW_MAX_DURATION_MINUTES,
  },
  pausedReason: row.pausedReason,
  formToken: row.formToken,
  formUrl: buildFormUrl(row.formToken),
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
  sourceConversationId: row.sourceConversationId,
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
