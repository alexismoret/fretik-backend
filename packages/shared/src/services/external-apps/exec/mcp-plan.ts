import type {
  ExternalAppConnection,
  ToolApprovalOperation,
  ToolApprovalOperationSummary,
} from "../../../db/schema";
import type { ExternalAppDescriptorAction } from "../../../schemas/external-app-descriptor";
import type { ToolPolicyLevel } from "../../../schemas/tool-policies";
import type { WorkflowAutonomy } from "../../../schemas/workflows";
import { resolveToolPolicy } from "../../tool-policies/resolve";
import { resolveConnection } from "../connections/resolve";
import { normalizeMcpResult } from "../mcp/normalize";
import { getSnapshotForConnection } from "../mcp/snapshot-store";
import { mcpCallTool } from "../mcp/transport";
import { buildGenericOperationSummary } from "../summaries/generic";
import { extractFrameworkArgs } from "./framework-args";

/**
 * MCP write ops — the snapshot-backed sibling of the manifest write path. A
 * `run_plan([...])` op whose action the registry doesn't know is resolved here:
 * the qualified name splits into descriptor key + action, the connection's
 * persisted snapshot supplies the descriptor action (with the real hyphenated
 * `mcpToolName`), and validation is generic (Pydantic in the sandbox + the MCP
 * server enforce the schema — there's no hand-written manifest to check).
 *
 * Two entry points share one resolver so the summary/policy the agent proposes
 * and the call the grant executes never diverge:
 *  - `resolveMcpWriteOp` — submit/edit time: policy level + generic summary.
 *  - `executeMcpWriteOp` — grant time: the actual `tools/call`, normalized.
 */

interface McpWriteAction {
  connection: ExternalAppConnection;
  providerKey: string;
  actionName: string;
  action: ExternalAppDescriptorAction;
  cleanArgs: Record<string, unknown>;
  frameworkConnectionId: string | undefined;
}

/**
 * Resolve one qualified `run_plan` op to its MCP connection + descriptor write
 * action. Throws a descriptive Error on any failure — the qualified name isn't
 * an MCP connection, the connection is still preparing, the action is unknown,
 * or it's a read misrouted into a plan. Callers map the message to their own
 * error envelope.
 */
const resolveMcpWriteAction = async (params: {
  op: ToolApprovalOperation;
  teamId: string;
  userId: string;
}): Promise<McpWriteAction> => {
  const { op } = params;
  const dot = op.action.indexOf(".");
  if (dot <= 0) throw new Error(`Unknown action in plan: ${op.action}`);
  const providerKey = op.action.slice(0, dot);
  const actionName = op.action.slice(dot + 1);

  const { framework, action: cleanArgs } = extractFrameworkArgs(op.args);

  let connection: ExternalAppConnection;
  try {
    connection = await resolveConnection({
      providerKey,
      teamId: params.teamId,
      userId: params.userId,
      explicitId: framework.connection_id,
    });
  } catch {
    throw new Error(`Unknown action in plan: ${op.action}`);
  }

  const snapshot = await getSnapshotForConnection(connection);
  if (snapshot === undefined) {
    throw new Error(
      `Connection "${connection.displayName}" is still preparing — its tools aren't ready yet. Retry shortly.`,
    );
  }

  const action = snapshot.descriptor.actions.find((a) => a.name === actionName);
  if (action === undefined) {
    throw new Error(`Unknown action in plan: ${op.action}`);
  }
  if (action.kind !== "write") {
    throw new Error(
      `Read action "${op.action}" in plan — call reads eagerly, not via run_plan().`,
    );
  }
  if (action.mcpToolName === undefined) {
    throw new Error(`Action ${op.action} has no MCP tool binding.`);
  }

  return {
    connection,
    providerKey,
    actionName,
    action,
    cleanArgs,
    frameworkConnectionId: framework.connection_id,
  };
};

export interface McpWriteResolution {
  connection: ExternalAppConnection;
  level: ToolPolicyLevel;
  storedArgs: Record<string, unknown>;
  summaryOp: ToolApprovalOperationSummary;
}

/**
 * Validate + summarize one MCP write op for the approval gate. `level` folds
 * the connection's per-action override and the run's autonomy over the
 * descriptor's `approvalDefault` (writes always start at `approval`). `blocked`
 * is returned, not thrown — the caller rejects the whole plan.
 */
export const resolveMcpWriteOp = async (params: {
  op: ToolApprovalOperation;
  teamId: string;
  userId: string;
  autonomy: WorkflowAutonomy | null;
}): Promise<McpWriteResolution> => {
  const resolved = await resolveMcpWriteAction(params);

  const level = resolveToolPolicy({
    kind: "write",
    defaultLevel: resolved.action.approvalDefault,
    override: resolved.connection.actionPolicies?.[resolved.actionName],
    autonomy: params.autonomy,
  });

  const storedArgs: Record<string, unknown> = { ...resolved.cleanArgs };
  if (resolved.frameworkConnectionId !== undefined) {
    storedArgs.connection_id = resolved.frameworkConnectionId;
  }

  const summaryOp = buildGenericOperationSummary({
    providerKey: resolved.providerKey,
    action: resolved.action,
    args: resolved.cleanArgs,
  });

  return { connection: resolved.connection, level, storedArgs, summaryOp };
};

/**
 * Execute one granted MCP write op — the `tools/call`, normalized to the shape
 * the sandbox runtime consumes (media blocks spill to `/workspace/attachments`).
 * Throws on transport / tool error; the caller records it as a per-op failure.
 */
export const executeMcpWriteOp = async (params: {
  op: ToolApprovalOperation;
  teamId: string;
  userId: string;
}): Promise<unknown> => {
  const resolved = await resolveMcpWriteAction(params);
  // `mcpToolName` is guaranteed present by resolveMcpWriteAction.
  const result = await mcpCallTool(
    resolved.connection,
    resolved.action.mcpToolName ?? resolved.action.name,
    resolved.cleanArgs,
  );
  return normalizeMcpResult(result);
};
