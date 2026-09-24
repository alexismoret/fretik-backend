import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../db";
import {
  aiConversations,
  type ToolApprovalRequest,
  type ToolApprovalToolCallResult,
  workflowRuns,
  workflows,
} from "../../../db/schema";
import { parseApiError } from "../../../schemas/errors";
import { TOOL_CALL_APPLY } from "../../tool-policies/builtin-apply";
import { markConsumed } from "../complete";
import { isToolCallPayload } from "../payload-guards";
import type { ApprovalKindHandler } from "./types";

const iso = (d: Date | null): string => (d ?? new Date()).toISOString();

/**
 * `tool_call` — ONE gated builtin write tool (manageLink / manageDrive /
 * uploadToDrive / manageRecord setStatus). Grant applies the stored, already-
 * resolved args via the shared apply map, which calls the SAME shared services
 * the tool's direct path uses. Never reaches the sandbox gate (no
 * `toSandboxData`): builtin tools substitute their tool-part output on decision
 * and are not re-called on the continuation turn.
 */
export const toolCallHandler: ApprovalKindHandler = {
  kind: "tool_call",
  execute: async ({ approval }): Promise<ToolApprovalToolCallResult> => {
    const result = await applyToolCall(approval);
    await markConsumed(approval.id, result);
    return result;
  },
  toToolOutput: (approval) => ({
    status: "approval_granted",
    approvalId: approval.id,
    result: approval.result ?? { ok: true, data: {} },
    grantedAt: iso(approval.decisionAt),
  }),
};

const applyToolCall = async (
  approval: ToolApprovalRequest,
): Promise<ToolApprovalToolCallResult> => {
  const payload = approval.payload;
  if (!isToolCallPayload(payload)) {
    return { ok: false, error: "tool_call approval has no tool-call payload" };
  }
  const apply = TOOL_CALL_APPLY[payload.toolName];
  if (apply === undefined) {
    return {
      ok: false,
      error: `No apply handler for tool ${payload.toolName}`,
    };
  }
  try {
    const data = await apply(
      {
        organizationId: approval.organizationId,
        teamId: approval.teamId,
        userId: approval.userId,
        conversationId: approval.conversationId,
        projectId: await projectOfConversation(approval.conversationId),
      },
      payload.args,
    );
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: failureMessage(error) };
  }
};

/**
 * The project the approved write works in, as it is now — where it lands at
 * a root. A workflow run's is its workflow's (a run's chat carries none of
 * its own, so moving the workflow moves its runs); a chat's is its own.
 */
const projectOfConversation = async (
  conversationId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({
      chat: aiConversations.projectId,
      workflow: workflows.projectId,
    })
    .from(aiConversations)
    .leftJoin(workflowRuns, eq(workflowRuns.conversationId, aiConversations.id))
    .leftJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(aiConversations.id, conversationId))
    .limit(1);
  return row?.workflow ?? row?.chat ?? null;
};

/**
 * What the approval card shows when applying failed. A refusal from the
 * access engine — the person was made a viewer, or left, while the approval
 * waited — carries its sentence inside a JSON envelope; the card shows the
 * sentence.
 */
const failureMessage = (error: unknown): string => {
  if (error instanceof HTTPException) {
    return parseApiError(error.message)?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
};
