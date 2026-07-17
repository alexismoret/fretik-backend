import type { ToolApprovalSummary } from "../../../db/schema";
import { TOOL_PERMISSIONS_REMEDIATION } from "../../ai/remediation";
import { createPendingApproval } from "../../approvals/create-pending";
import { runApprovalGate } from "../../approvals/gate";
import { canonicalHash } from "../../approvals/hash";
import type { ExecContext, SandboxExecResponse } from "../../sandbox/types";
import { resolveToolPolicy } from "../../tool-policies/resolve";
import { getWorkflowAutonomyForConversation } from "../../workflows/get-run-autonomy";
import { resolveConnection } from "../connections/resolve";
import { normalizeMcpResult } from "../mcp/normalize";
import { getSnapshotForConnection } from "../mcp/snapshot-store";
import { mcpCallTool } from "../mcp/transport";
import { extractFrameworkArgs } from "./framework-args";

/**
 * Read path for an MCP-sourced action — the snapshot-backed sibling of
 * `dispatchRead` (which resolves manifest actions from the registry). Called
 * when `getAction` finds no manifest action: the qualified name is split into
 * the descriptor key + action name, the connection's persisted snapshot is
 * loaded, and the matched descriptor action is dispatched to the MCP server
 * via `mcpCallTool` (with the real hyphenated `mcpToolName`), its result
 * normalized. Same policy/approval gate as the manifest path, keyed off the
 * descriptor's `approvalDefault` (curated reads auto-run; custom gate).
 */
export const dispatchMcpRead = async (
  ctx: ExecContext,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const dot = qualifiedName.indexOf(".");
  if (dot <= 0) {
    return { status: "error", message: `Unknown action: ${qualifiedName}` };
  }
  const providerKey = qualifiedName.slice(0, dot);
  const actionName = qualifiedName.slice(dot + 1);

  const { framework, action: actionArgs } = extractFrameworkArgs(args);

  let connection;
  try {
    connection = await resolveConnection({
      providerKey,
      teamId: ctx.teamId,
      userId: ctx.userId,
      explicitId: framework.connection_id,
    });
  } catch {
    return { status: "error", message: `Unknown action: ${qualifiedName}` };
  }

  const snapshot = await getSnapshotForConnection(connection);
  if (snapshot === undefined) {
    return {
      status: "error",
      message: `Connection "${connection.displayName}" is still preparing — its tools aren't ready yet. Retry shortly.`,
    };
  }

  const action = snapshot.descriptor.actions.find((a) => a.name === actionName);
  if (action === undefined) {
    return { status: "error", message: `Unknown action: ${qualifiedName}` };
  }
  if (action.kind !== "read") {
    return {
      status: "error",
      message: `Action ${qualifiedName} is a write — submit it via run_plan().`,
    };
  }
  if (action.mcpToolName === undefined) {
    return {
      status: "error",
      message: `Action ${qualifiedName} has no MCP tool binding.`,
    };
  }

  const autonomy = await getWorkflowAutonomyForConversation(ctx.conversationId);
  const level = resolveToolPolicy({
    kind: "read",
    defaultLevel: action.approvalDefault,
    override: connection.actionPolicies?.[actionName],
    autonomy,
  });

  if (level === "blocked") {
    return {
      status: "error",
      message: `ACTION_DISABLED: ${qualifiedName} is disabled on connection "${connection.displayName}" by its permission settings. ${TOOL_PERMISSIONS_REMEDIATION}`,
    };
  }

  if (level === "approval") {
    const opArgs = { ...actionArgs, connection_id: connection.id };
    const lookupHash = canonicalHash({ action: qualifiedName, args: opArgs });
    const summary: ToolApprovalSummary = {
      titleKey: "default",
      titleParams: { count: 1 },
      operations: [
        { providerKey, action: actionName, titleKey: "default", fields: [] },
      ],
    };
    return runApprovalGate({
      ctx,
      kind: "external_app_read",
      autonomy,
      autoGrant: false,
      lookupHash,
      createPending: () =>
        createPendingApproval({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          turnId: ctx.turnId,
          lookupHash,
          operations: [{ action: qualifiedName, args: opArgs }],
          summary,
          kind: "external_app_read",
        }),
    });
  }

  // auto — call the MCP tool eagerly. The server validates args and the raw
  // result is normalized (media blocks spill to /workspace/attachments).
  try {
    const result = await mcpCallTool(
      connection,
      action.mcpToolName,
      actionArgs,
    );
    return { status: "ok", data: normalizeMcpResult(result) };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
