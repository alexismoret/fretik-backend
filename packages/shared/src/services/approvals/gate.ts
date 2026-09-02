import type { ToolApprovalKind, ToolApprovalRequest } from "../../db/schema";
import { withConversationLock } from "../../lib/redis-lock";
import type { WorkflowAutonomy } from "../../schemas/workflows";
import type { SandboxExecResponse } from "../sandbox/types";
import { claimGrantedApproval, markFailedApproval } from "./claim";
import { approvalFailureReason } from "./failure-reason";
import { findLatestApprovalByHash, findPendingApprovals } from "./find";
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
 * How long an INLINE execution may sit in `executing` before the gate declares
 * it interrupted, fails it, and lets the operation be proposed again.
 *
 * This is the crash net, NOT the normal error path: every site that can catch
 * an execution error marks the row `failed` on the spot (here and in
 * `execute-decision.ts`), so a Postgres error costs the user no wait at all.
 * What lands here is a process that died mid-write — SIGKILL, OOM, a deploy
 * during the grant — where no catch could run.
 *
 * Only inline kinds are swept. An inline execution lives inside the grant's own
 * HTTP request and cannot outlive it, so ten idle minutes prove nobody is on
 * it. A DEFERRED kind (a staged import handed to BullMQ) is exempt and must
 * stay so: it legitimately holds `executing` for as long as the load takes —
 * far past ten minutes on a large file — and `finishBulkOperation` owns closing
 * its row. Sweeping it would re-open a card for a write that is still running.
 *
 * Erring long is deliberate: failing a row that IS still executing would let
 * the same write be granted twice.
 */
const STALE_INLINE_EXECUTION_MS = 10 * 60 * 1000;

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
      // Close the claim before reporting. Leaving it `executing` would answer
      // every later attempt at this exact write with "currently executing" and
      // never open a card again — the operation would be dead for the rest of
      // the conversation. `failed` is skipped by the hash lookup, so the next
      // identical call starts a fresh request.
      const message = approvalFailureReason(error);
      await markFailedApproval(claimed.id, message);
      return { status: "error", message };
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

  // An inline execution that has been `executing` for longer than any HTTP
  // request could live has no executor left (see STALE_INLINE_EXECUTION_MS).
  // Fail it and forget it, so the block below opens a fresh request instead of
  // answering "currently executing" forever.
  if (
    existing?.status === "executing" &&
    handler.deferExecution?.(existing) !== true &&
    Date.now() - (existing.executedAt ?? existing.createdAt).getTime() >
      STALE_INLINE_EXECUTION_MS
  ) {
    await markFailedApproval(
      existing.id,
      "Execution was interrupted before it could report an outcome.",
    );
    existing = undefined;
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
      // Someone IS working on this exact write — a peer request, or the worker
      // draining a staged import. Re-running the code cannot help and a second
      // grant would write twice, so say plainly that the only move is to wait.
      const since = (existing.executedAt ?? existing.createdAt).toISOString();
      return {
        status: "error",
        message: `This exact operation was already approved and is executing (since ${since}). Do NOT re-run it — wait for it to finish, or ask the user to check it.`,
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

  // Autonomous runs never pause and never single-flight: create + grant +
  // execute in place. Parallel autonomous writes each keep their own row.
  if (autoGrant) {
    const pending = await createPending();
    const granted = await grantApproval({
      id: pending.id,
      teamId: ctx.teamId,
      userId: ctx.userId,
    });
    return claimAndExecute(granted);
  }

  // Human review: enforce exactly ONE pending approval per conversation. The
  // lock serializes the "already pending?" check + the INSERT across the two
  // producer processes (AI + API), so N parallel tool calls or sub-agents can't
  // each open their own card. The first wins; the rest defer (any kind blocks
  // any kind — a pending read blocks a later write and vice versa) and are told
  // to re-issue after the pending one is resolved.
  return withConversationLock(ctx.conversationId, async () => {
    const pendings = await findPendingApprovals(ctx.conversationId);
    // A peer with the SAME write may have created it in the lock's shadow —
    // dedup to that row instead of a duplicate (or a false self-block).
    const sameHash = pendings.find((p) => p.lookupHash === lookupHash);
    if (sameHash !== undefined) {
      await markSandboxApprovalPending(ctx.conversationId, sameHash.id);
      return { status: "approval_pending", approvalId: sameHash.id };
    }
    // Any OTHER pending approval blocks this one — defer without inserting.
    const blocking = pendings[0];
    if (blocking !== undefined) {
      return { status: "approval_deferred", blockingApprovalId: blocking.id };
    }
    const pending = await createPending();
    await markSandboxApprovalPending(ctx.conversationId, pending.id);
    return { status: "approval_pending", approvalId: pending.id };
  });
};
