import type {
  ToolApprovalOperation,
  ToolApprovalSummary,
} from "../../../db/schema";
import { computeLookupHash } from "../../../external-apps/hash";
import { getAction } from "../../../external-apps/registry";
import { claimGrantedApproval } from "../approvals/claim";
import { createPendingApproval } from "../approvals/create-pending";
import { findLatestApprovalByHash } from "../approvals/find";
import { markSandboxApprovalPending } from "../approvals/sandbox-signal";
import { resolveConnection } from "../connections/resolve";
import { buildRequest } from "./build-request";
import { callCustomHandler } from "./call-custom-handler";
import { extractFrameworkArgs } from "./framework-args";
import { callHttpDirect } from "./http-direct";
import { callNangoProxy } from "./nango-proxy";
import { executePlan } from "./plan-executor";
import type {
  ExecContext,
  SandboxExecRequest,
  SandboxExecResponse,
} from "./types";
import { validateActionArgs } from "./validate-args";

/**
 * Entry point of `POST /sandbox/exec`. Routes a sandbox request to either
 * an immediate read execution or the plan-gating pipeline. Authoritative
 * checks all live here — the Python SDK's Pydantic validation upstream
 * is convenience, not security.
 */

export const dispatchSandboxExec = async (
  ctx: ExecContext,
  request: SandboxExecRequest,
): Promise<SandboxExecResponse> => {
  if (request.kind === "read") {
    return dispatchRead(ctx, request.action, request.args);
  }
  return dispatchPlan(ctx, request.operations);
};

// ── Read path ─────────────────────────────────────────────────────────

const dispatchRead = async (
  ctx: ExecContext,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const resolved = getAction(qualifiedName);
  if (resolved === undefined) {
    return {
      status: "error",
      message: `Unknown action: ${qualifiedName}`,
    };
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

  try {
    const connection = await resolveConnection({
      providerKey: resolved.providerKey,
      teamId: ctx.teamId,
      userId: ctx.userId,
      explicitId: framework.connection_id,
    });

    let data: unknown;
    if (resolved.transport.kind === "nango-proxy") {
      const req = buildRequest(resolved, validated);
      const raw = await callNangoProxy({
        providerConfigKey: connection.nangoProviderConfigKey,
        connectionId: connection.nangoConnectionId,
        method: req.method,
        endpoint: req.endpoint,
        query: req.query,
        body: req.body,
        headers: req.headers,
        paginate: req.paginate,
      });
      data =
        resolved.responseMapper !== undefined
          ? resolved.responseMapper(raw)
          : raw;
    } else if (resolved.transport.kind === "http-direct") {
      const req = buildRequest(resolved, validated);
      const raw = await callHttpDirect({
        manifest: resolved.manifest,
        transport: resolved.transport,
        providerConfigKey: connection.nangoProviderConfigKey,
        connectionId: connection.nangoConnectionId,
        method: req.method,
        endpoint: req.endpoint,
        query: req.query,
        body: req.body,
      });
      data =
        resolved.responseMapper !== undefined
          ? resolved.responseMapper(raw)
          : raw;
    } else {
      // custom-handler — the handler is responsible for returning the
      // shape declared by the manifest's `returns`. No response mapper.
      if (resolved.handler === undefined) {
        return {
          status: "error",
          message: `Action ${qualifiedName} has no handler registered`,
        };
      }
      data = await callCustomHandler({
        manifest: resolved.manifest,
        providerConfigKey: connection.nangoProviderConfigKey,
        connectionId: connection.nangoConnectionId,
        handler: resolved.handler,
        args: validated,
      });
    }
    return { status: "ok", data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", message };
  }
};

// ── Plan path ─────────────────────────────────────────────────────────

const dispatchPlan = async (
  ctx: ExecContext,
  operations: ToolApprovalOperation[],
): Promise<SandboxExecResponse> => {
  if (operations.length === 0) {
    return { status: "error", message: "Empty plan." };
  }

  // 1. Validate every op against the registry + manifest. Any failure
  //    rejects the WHOLE plan — atomicity at the approval level.
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

  // 2. Lookup hash + find latest approval for this plan.
  const lookupHash = computeLookupHash(validatedOps);
  const existing = await findLatestApprovalByHash({
    conversationId: ctx.conversationId,
    lookupHash,
  });

  // 3. Branch on status.
  if (existing !== undefined) {
    if (existing.status === "pending") {
      await markSandboxApprovalPending(ctx.conversationId, existing.id);
      return { status: "approval_pending", approvalId: existing.id };
    }
    if (existing.status === "executing") {
      return {
        status: "error",
        message:
          "Plan is currently executing or was interrupted — check the provider state before retrying.",
        data: { partialResult: existing.result },
      };
    }
    if (existing.status === "consumed") {
      // Idempotent: return the cached per-op result.
      return { status: "ok", data: existing.result };
    }
    if (existing.status === "granted") {
      // Claim atomically then execute.
      const claimed = await claimGrantedApproval(existing.id);
      if (claimed === undefined) {
        // A concurrent dispatch already claimed it — re-read state.
        const reread = await findLatestApprovalByHash({
          conversationId: ctx.conversationId,
          lookupHash,
        });
        if (reread?.status === "consumed") {
          return { status: "ok", data: reread.result };
        }
        return {
          status: "error",
          message: "Plan claim raced with another dispatch — retry.",
        };
      }
      try {
        const result = await executePlan({
          approval: claimed,
          teamId: ctx.teamId,
          userId: ctx.userId,
        });
        return { status: "ok", data: result };
      } catch (error) {
        return {
          status: "error",
          message:
            error instanceof Error ? error.message : "Plan execution failed",
        };
      }
    }
  }

  // 4. No live approval → INSERT a fresh `pending`.
  const summary: ToolApprovalSummary = {
    titleKey: "default",
    titleParams: { count: validatedOps.length },
    operations: summaryOps,
  };
  const pending = await createPendingApproval({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    turnId: ctx.turnId,
    lookupHash,
    operations: validatedOps,
    summary,
  });
  await markSandboxApprovalPending(ctx.conversationId, pending.id);
  return { status: "approval_pending", approvalId: pending.id };
};
