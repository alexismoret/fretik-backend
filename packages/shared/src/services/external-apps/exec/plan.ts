import type {
  ToolApprovalOperation,
  ToolApprovalSummary,
} from "../../../db/schema";
import { computeLookupHash } from "../../../external-apps/hash";
import { getAction } from "../../../external-apps/registry";
import { createPendingApproval } from "../../approvals/create-pending";
import { runApprovalGate } from "../../approvals/gate";
import type { ExecContext, SandboxExecResponse } from "../../sandbox/types";
import { getWorkflowAutonomyForConversation } from "../../workflows/get-run-autonomy";
import { extractFrameworkArgs } from "./framework-args";
import { validateActionArgs } from "./validate-args";

/**
 * Plan path of `POST /sandbox/exec` — a `run_plan([...])` write plan of one or
 * more external-app write actions. Validates every op atomically (any failure
 * rejects the whole plan), resolves workflow autonomy, then hands the request
 * to the generic approval gate as the `external_app_plan` kind: it dedups on
 * `lookupHash`, pauses for a human decision (or auto-grants an autonomous run),
 * and executes via Nango (`executePlan`) on grant.
 */
export const dispatchPlan = async (
  ctx: ExecContext,
  operations: ToolApprovalOperation[],
): Promise<SandboxExecResponse> => {
  if (operations.length === 0) {
    return { status: "error", message: "Empty plan." };
  }

  // Validate every op against the registry + manifest. Any failure rejects the
  // WHOLE plan — atomicity at the approval level.
  const validatedOps: ToolApprovalOperation[] = [];
  const summaryOps: ToolApprovalSummary["operations"] = [];
  for (const op of operations) {
    const resolved = getAction(op.action);
    if (resolved === undefined) {
      return {
        status: "error",
        message: `Unknown action in plan: ${op.action}`,
      };
    }
    if (resolved.action.kind !== "write") {
      return {
        status: "error",
        message: `Read action "${op.action}" in plan — call reads eagerly, not via run_plan().`,
      };
    }
    if (resolved.summary === undefined) {
      return {
        status: "error",
        message: `Action ${op.action} has no summary mapper`,
      };
    }
    const { framework, action: actionArgs } = extractFrameworkArgs(op.args);
    let validated: Record<string, unknown>;
    try {
      validated = validateActionArgs(op.action, resolved.action, actionArgs);
    } catch (error) {
      return {
        status: "error",
        message: `Invalid args for ${op.action}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const storedArgs: Record<string, unknown> = { ...validated };
    if (framework.connection_id !== undefined) {
      storedArgs.connection_id = framework.connection_id;
    }
    validatedOps.push({ action: op.action, args: storedArgs });

    const part = resolved.summary(validated);
    summaryOps.push({
      providerKey: resolved.providerKey,
      action: resolved.action.name,
      titleKey: part.titleKey,
      titleParams: part.titleParams,
      fields: part.fields,
    });
  }

  // Workflow autonomy gate: a `read_only` run may never perform external writes.
  const autonomy = await getWorkflowAutonomyForConversation(ctx.conversationId);
  if (autonomy === "read_only") {
    return {
      status: "error",
      message:
        "READ_ONLY_WORKFLOW: this run cannot perform external write actions. Note in the task summary what would have been written.",
    };
  }

  const lookupHash = computeLookupHash(validatedOps);
  const summary: ToolApprovalSummary = {
    titleKey: "default",
    titleParams: { count: validatedOps.length },
    operations: summaryOps,
  };

  return runApprovalGate({
    ctx,
    kind: "external_app_plan",
    autonomy,
    lookupHash,
    createPending: () =>
      createPendingApproval({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        turnId: ctx.turnId,
        lookupHash,
        operations: validatedOps,
        summary,
      }),
  });
};
