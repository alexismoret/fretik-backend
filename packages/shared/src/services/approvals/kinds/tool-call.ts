import type {
  ToolApprovalRequest,
  ToolApprovalToolCallResult,
} from "../../../db/schema";
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
      },
      payload.args,
    );
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
