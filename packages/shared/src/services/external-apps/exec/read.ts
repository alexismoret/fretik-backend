import type { ToolApprovalSummary } from "../../../db/schema";
import { getAction } from "../../../external-apps/registry";
import { createPendingApproval } from "../../approvals/create-pending";
import { runApprovalGate } from "../../approvals/gate";
import { canonicalHash } from "../../approvals/hash";
import type { ExecContext, SandboxExecResponse } from "../../sandbox/types";
import { resolveConnectionActionPolicy } from "../../tool-policies/resolve";
import { getWorkflowAutonomyForConversation } from "../../workflows/get-run-autonomy";
import { resolveConnection } from "../connections/resolve";
import { extractFrameworkArgs } from "./framework-args";
import { dispatchMcpRead } from "./mcp-read";
import { executeReadAction } from "./read-executor";
import { validateActionArgs } from "./validate-args";

/**
 * Read path of `POST /sandbox/exec` — a single external-app read action. The
 * connection's per-action policy decides: `auto` runs it eagerly (no approval
 * row), `approval` gates it via the `external_app_read` kind (the read runs on
 * grant and its raw data is replayed on re-run), `blocked` refuses it.
 * Authoritative validation lives here; the Python SDK's upstream validation is
 * convenience, not security.
 */
export const dispatchRead = async (
  ctx: ExecContext,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const resolved = getAction(qualifiedName);
  if (resolved === undefined) {
    // Not a hand-written manifest action — try the MCP snapshot path (returns
    // an "unknown action" error if it isn't an MCP action either).
    return dispatchMcpRead(ctx, qualifiedName, args);
  }
  if (resolved.action.kind !== "read") {
    return {
      status: "error",
      message: `Action ${qualifiedName} is a write — submit it via run_plan().`,
    };
  }

  const { framework, action: actionArgs } = extractFrameworkArgs(args);

  let validated: Record<string, unknown>;
  try {
    validated = validateActionArgs(qualifiedName, resolved.action, actionArgs);
  } catch (error) {
    return {
      status: "error",
      message: `Invalid args for ${qualifiedName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let connection;
  try {
    connection = await resolveConnection({
      providerKey: resolved.providerKey,
      teamId: ctx.teamId,
      userId: ctx.userId,
      explicitId: framework.connection_id,
    });
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const autonomy = await getWorkflowAutonomyForConversation(ctx.conversationId);
  const level = resolveConnectionActionPolicy({
    action: { name: resolved.action.name, kind: "read" },
    actionPolicies: connection.actionPolicies,
    autonomy,
  });

  if (level === "blocked") {
    return {
      status: "error",
      message: `ACTION_DISABLED: ${qualifiedName} is disabled on connection "${connection.displayName}" by its permission settings. Tell the user it can be re-enabled in Settings → Tool permissions.`,
    };
  }

  if (level === "approval") {
    // Store the resolved connection id on the op so the grant targets the exact
    // same connection; hash without a turn id so a cross-turn re-run replays.
    const opArgs = { ...validated, connection_id: connection.id };
    const lookupHash = canonicalHash({ action: qualifiedName, args: opArgs });
    const summary: ToolApprovalSummary = {
      titleKey: "default",
      titleParams: { count: 1 },
      operations: [
        {
          providerKey: resolved.providerKey,
          action: resolved.action.name,
          titleKey: "default",
          fields: [],
        },
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

  // auto — run eagerly, no approval row.
  try {
    const data = await executeReadAction(resolved, connection, validated);
    return { status: "ok", data };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
