import type { ToolApprovalKind, ToolApprovalRequest } from "../../db/schema";
import type { WorkflowAutonomy } from "../../schemas/workflows";
import type { SandboxExecResponse } from "../sandbox/types";
import { claimGrantedApproval } from "./claim";
import { findLatestApprovalByHash } from "./find";
import { grantApproval } from "./grant";
import { APPROVAL_KIND_HANDLERS } from "./kinds";
import { markSandboxApprovalPending } from "./sandbox-signal";

/** Minimal tenant context the gate needs — a structural subset of the sandbox
 * `ExecContext`, so any producer can drive it. */
export interface ApprovalGateContext {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
}

/**
 * THE generic approval state machine, shared by every sandbox-driven kind
 * (`external_app_plan`, `record_write`). It owns exactly one concern: given a
 * dedup `lookupHash` and a lazy `createPending`, resolve the request against the
 * existing row (pending / executing / consumed / granted) and, on `autonomous`,
 * auto-grant + execute in place. The caller has already rejected `read_only`
 * and decided that an approval is warranted (not a plain direct write).
 *
 * Kind-specific behaviour comes from `APPROVAL_KIND_HANDLERS[kind]`:
 * `execute` (the write) and `toSandboxData` (the wire shape on ok). The dedup
 * `lookupHash` and `createPending` are producer closures — they need the
 * producer's validated input, and `createPending` must stay LAZY (it only runs
 * when no live row exists, so a workflow-turn retry never re-does the metadata
 * fetch).
 */
export const runApprovalGate = async (params: {
  ctx: ApprovalGateContext;
  kind: ToolApprovalKind;
  autonomy: WorkflowAutonomy | null;
  lookupHash: string;
  createPending: () => Promise<ToolApprovalRequest>;
  /**
   * Optional dry-run validation, run ONCE right before a FRESH pending is
   * created for a human to grant (never on replay, never for `autonomous`
   * which keeps its partial-success contract). Non-empty result aborts: the
   * agent gets the per-row errors instantly instead of after the grant.
   */
  validateBeforePending?: () => Promise<{ index: number; error: string }[]>;
  /**
   * Force auto-grant (skip the human, grant + execute in place) regardless of
   * autonomy. Defaults to `autonomy === "autonomous"`. Set `true` when a
   * per-tool/per-action policy resolved to `auto` in plain chat — the write
   * still flows through the gate (keeping the audit row + replay cache), it
   * just never pauses.
   */
  autoGrant?: boolean;
}): Promise<SandboxExecResponse> => {
  const { ctx, kind, autonomy, lookupHash, createPending } = params;
  const handler = APPROVAL_KIND_HANDLERS[kind];
  const autoGrant = params.autoGrant ?? autonomy === "autonomous";

  // Claim a `granted` row atomically, execute it (per kind), return the wire
  // result. A lost claim race re-reads: a peer that already consumed it wins
  // the cached result; anything else is a transient "retry".
  const claimAndExecute = async (
    approval: ToolApprovalRequest,
  ): Promise<SandboxExecResponse> => {
    const claimed = await claimGrantedApproval(approval.id);
    if (claimed === undefined) {
      const reread = await findLatestApprovalByHash({
        conversationId: ctx.conversationId,
        lookupHash,
      });
      if (reread?.status === "consumed") {
        return {
          status: "ok",
          data: handler.toSandboxData?.(reread, reread.result ?? []),
        };
      }
      return {
        status: "error",
        message: "Approval claim raced with another dispatch — retry.",
      };
    }
    try {
      const result = await handler.execute({ approval: claimed });
      return {
        status: "ok",
        data: handler.toSandboxData?.(claimed, result),
      };
    } catch (error) {
      return {
        status: "error",
        message:
          error instanceof Error ? error.message : "Approval execution failed",
      };
    }
  };

  let existing = await findLatestApprovalByHash({
    conversationId: ctx.conversationId,
    lookupHash,
  });

  // Autonomous runs never pause: grant a pending row in place, then fall through
  // to the `granted` branch below.
  if (autoGrant && existing?.status === "pending") {
    existing = await grantApproval({
      id: existing.id,
      teamId: ctx.teamId,
      userId: ctx.userId,
    });
  }

  if (existing !== undefined) {
    if (existing.status === "pending") {
      // Out-of-band Redis bridge to the `python` tool: if the agent swallows
      // the sandbox's `ApprovalPending` exception (try/except, or just
      // prints it), the tool still surfaces the approval card via this
      // signal instead of silently hanging. See `sandbox-signal.ts`.
      await markSandboxApprovalPending(ctx.conversationId, existing.id);
      return { status: "approval_pending", approvalId: existing.id };
    }
    if (existing.status === "executing") {
      return {
        status: "error",
        message:
          "Approval is currently executing or was interrupted — check state before retrying.",
        data:
          existing.result !== null
            ? { partialResult: existing.result }
            : undefined,
      };
    }
    if (existing.status === "consumed") {
      return {
        status: "ok",
        data: handler.toSandboxData?.(existing, existing.result ?? []),
      };
    }
    if (existing.status === "granted") {
      return claimAndExecute(existing);
    }
  }

  // Fresh submission for human review: validate before creating the pending so
  // a format error surfaces now, not after the grant. Skipped for `autonomous`
  // (partial-success write) and on replays (an existing row short-circuited above).
  if (!autoGrant && params.validateBeforePending !== undefined) {
    const rowErrors = await params.validateBeforePending();
    if (rowErrors.length > 0) {
      return {
        status: "error",
        message: "Some rows failed validation — fix them and resubmit.",
        data: { rowErrors },
      };
    }
  }

  const pending = await createPending();
  if (autoGrant) {
    const granted = await grantApproval({
      id: pending.id,
      teamId: ctx.teamId,
      userId: ctx.userId,
    });
    return claimAndExecute(granted);
  }
  await markSandboxApprovalPending(ctx.conversationId, pending.id);
  return { status: "approval_pending", approvalId: pending.id };
};
