import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import {
  BUILTIN_TOOL_POLICY_CATALOG,
  type ToolPolicyLevel,
} from "@fretik/shared/schemas/tool-policies";
import { deferredToolOutput } from "@fretik/shared/services/ai/approval-pending";
import { TOOL_PERMISSIONS_REMEDIATION } from "@fretik/shared/services/ai/remediation";
import { createPendingToolCallApproval } from "@fretik/shared/services/approvals/create-pending-tool-call";
import { runApprovalGate } from "@fretik/shared/services/approvals/gate";
import { canonicalHash } from "@fretik/shared/services/approvals/hash";
import { resolveBuiltinToolPolicy } from "@fretik/shared/services/tool-policies/resolve";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * The team-policy tool gate — the builtin-tool counterpart to the workflow
 * autonomy gate (`workflow-tool-gate.ts`). Resolves each policy-managed tool's
 * effective level from the team's `toolPolicies` map + the run's workflow
 * autonomy (via the shared `resolveBuiltinToolPolicy`) and reports which tools
 * are `blocked` so `prepareStep` can PRUNE them from `activeTools` (and the
 * prompt renderer + `searchTools` can hide them). Enforcement is defense in
 * depth: pruning keeps a blocked tool out of the model's context entirely;
 * a per-tool `execute` backstop catches a guessed call anyway.
 *
 * `python` / `bash` / `memory` and other infra tools are NOT in the catalog, so
 * `resolveBuiltinToolPolicy` returns `auto` for them — they are never hidden.
 */

/** Effective policy level for one builtin tool given the turn's context. */
export const resolveBuiltinPolicy = (
  ctx: AgentRuntimeContext,
  toolName: string,
): ToolPolicyLevel =>
  resolveBuiltinToolPolicy({
    toolName,
    teamPolicies: ctx.toolPolicies ?? {},
    autonomy: ctx.workflowAutonomy ?? null,
  });

/**
 * Names of policy-managed tools that resolve to `blocked` for this turn — the
 * set `prepareStep` unions into its hidden gate and the prompt renderer /
 * `searchTools` consult. Only catalog tools can appear (infra tools resolve to
 * `auto`), so this is a cheap pass over the catalog.
 */
export const policyHiddenToolNames = (
  ctx: AgentRuntimeContext,
): ReadonlySet<string> => {
  const hidden = new Set<string>();
  for (const name of Object.keys(BUILTIN_TOOL_POLICY_CATALOG)) {
    if (resolveBuiltinPolicy(ctx, name) === "blocked") hidden.add(name);
  }
  return hidden;
};

/** The `approval_pending` marker a gated tool returns so the turn pauses and
 * the frontend renders the approval card (detected by shape, not tool name). */
interface ApprovalPendingOutput {
  status: "approval_pending";
  approvalId: string;
}

/**
 * Per-tool policy gate for a `tool_call`-kind write tool (manageRecord /
 * manageLink / manageDrive / uploadToDrive). Call it in the tool's `execute`
 * AFTER validating + resolving the write's args (so the stored payload is
 * ready-to-apply). Returns:
 *  - a `toolError` when the team `blocked` the tool (backstop for a guessed
 *    name the menu-prune didn't catch),
 *  - an `approval_pending` marker when the level is `approval` — the caller
 *    returns it verbatim and the turn stops for a human decision,
 *  - `null` when the level is `auto` — the caller proceeds with its direct
 *    write (no approval row, today's behaviour).
 *
 * The stored `args` MUST match the tool's `builtin-apply` entry, since the grant
 * applies them server-side (API process) via that map.
 */
export const gateBuiltinWriteTool = async (
  ctx: AgentRuntimeContext,
  params: {
    toolName: string;
    args: Record<string, unknown>;
    note?: string;
    summaryFields?: ToolApprovalSummaryField[];
  },
): Promise<
  | ApprovalPendingOutput
  | ReturnType<typeof deferredToolOutput>
  | ReturnType<typeof toolError>
  | null
> => {
  const level = resolveBuiltinPolicy(ctx, params.toolName);
  if (level === "blocked") {
    return toolError(
      TOOL_ERROR_CODES.TOOL_DISABLED_BY_POLICY,
      `${params.toolName} is disabled by the team's tool-permission settings.`,
      TOOL_PERMISSIONS_REMEDIATION,
    );
  }
  if (level === "auto") return null;

  // approval — needs a conversation + user to attach the request to. Chat turns
  // always have both; if somehow absent, fall through to the direct write.
  if (ctx.conversationId === undefined || ctx.userId === undefined) return null;
  const conversationId = ctx.conversationId;
  const userId = ctx.userId;
  const turnId = ctx.traceId ?? conversationId;
  const lookupHash = canonicalHash({
    tool: params.toolName,
    turnId,
    args: params.args,
  });

  const resp = await runApprovalGate({
    ctx: {
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId,
      conversationId,
      turnId,
    },
    kind: "tool_call",
    autonomy: ctx.workflowAutonomy ?? null,
    autoGrant: false,
    lookupHash,
    createPending: () =>
      createPendingToolCallApproval({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId,
        conversationId,
        turnId,
        lookupHash,
        payload: {
          toolName: params.toolName,
          args: params.args,
          note: params.note,
          summaryFields: params.summaryFields,
        },
      }),
  });

  if (resp.status === "approval_pending") {
    return { status: "approval_pending", approvalId: resp.approvalId };
  }
  // Single-flight: another approval is already pending — do not open a second
  // card; tell the model to wait and re-issue after it's resolved.
  if (resp.status === "approval_deferred") {
    return deferredToolOutput(resp.blockingApprovalId);
  }
  if (resp.status === "error") {
    return toolError(
      TOOL_ERROR_CODES.TOOL_DISABLED_BY_POLICY,
      resp.message ?? "Approval could not be created.",
    );
  }
  // `ok` (an already-consumed grant replayed) — the write already happened
  // server-side; surface success without re-writing.
  return null;
};
