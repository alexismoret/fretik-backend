import type {
  ExternalAppConnection,
  ToolApprovalOperation,
  ToolApprovalSummary,
} from "../../../db/schema";
import { computeLookupHash } from "../../../external-apps/hash";
import { getAction } from "../../../external-apps/registry";
import { TOOL_PERMISSIONS_REMEDIATION } from "../../ai/remediation";
import { createPendingApproval } from "../../approvals/create-pending";
import { runApprovalGate } from "../../approvals/gate";
import type { ExecContext, SandboxExecResponse } from "../../sandbox/types";
import { resolveConnectionActionPolicy } from "../../tool-policies/resolve";
import { getWorkflowAutonomyForConversation } from "../../workflows/get-run-autonomy";
import { resolveConnection } from "../connections/resolve";
import { extractFrameworkArgs } from "./framework-args";
import { resolveMcpWriteOp } from "./mcp-plan";
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

  // Workflow autonomy gate: a `read_only` run may never perform external writes.
  const autonomy = await getWorkflowAutonomyForConversation(ctx.conversationId);
  if (autonomy === "read_only") {
    return {
      status: "error",
      message:
        "READ_ONLY_WORKFLOW: this run cannot perform external write actions. Note in the task summary what would have been written.",
    };
  }

  // Per-plan connection cache (dedupe resolution by provider + connection_id).
  const connCache = new Map<string, ExternalAppConnection>();
  const resolveOpConnection = async (
    providerKey: string,
    explicitId: string | undefined,
  ): Promise<ExternalAppConnection> => {
    const key = `${providerKey}:${explicitId ?? ""}`;
    const cached = connCache.get(key);
    if (cached !== undefined) return cached;
    const conn = await resolveConnection({
      providerKey,
      teamId: ctx.teamId,
      userId: ctx.userId,
      explicitId,
    });
    connCache.set(key, conn);
    return conn;
  };

  // Validate every op against the registry + manifest, resolve its connection
  // policy. Any failure (or a `blocked` action) rejects the WHOLE plan —
  // atomicity at the approval level. `autoGrant` only when EVERY op resolves to
  // `auto` (a connection opted its writes into no-approval); otherwise the plan
  // pauses for a human (today's behaviour under chat / approval_required).
  const validatedOps: ToolApprovalOperation[] = [];
  const summaryOps: ToolApprovalSummary["operations"] = [];
  let allAuto = true;
  for (const op of operations) {
    const resolved = getAction(op.action);
    if (resolved === undefined) {
      // Not a hand-written manifest action — resolve it against the connection's
      // MCP snapshot (generic summary, schema enforced by the server + Pydantic).
      let mcp;
      try {
        mcp = await resolveMcpWriteOp({
          op,
          teamId: ctx.teamId,
          userId: ctx.userId,
          autonomy,
        });
      } catch (error) {
        return {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (mcp.level === "blocked") {
        return {
          status: "error",
          message: `ACTION_DISABLED: ${op.action} is disabled on connection "${mcp.connection.displayName}" by its permission settings. ${TOOL_PERMISSIONS_REMEDIATION}`,
        };
      }
      if (mcp.level !== "auto") allAuto = false;
      validatedOps.push({ action: op.action, args: mcp.storedArgs });
      summaryOps.push(mcp.summaryOp);
      continue;
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

    let connection: ExternalAppConnection;
    try {
      connection = await resolveOpConnection(
        resolved.providerKey,
        framework.connection_id,
      );
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const level = resolveConnectionActionPolicy({
      action: { name: resolved.action.name, kind: "write" },
      actionPolicies: connection.actionPolicies,
      autonomy,
    });
    if (level === "blocked") {
      return {
        status: "error",
        message: `ACTION_DISABLED: ${op.action} is disabled on connection "${connection.displayName}" by its permission settings. ${TOOL_PERMISSIONS_REMEDIATION}`,
      };
    }
    if (level !== "auto") allAuto = false;

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
    autoGrant: allAuto,
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
