import type { ToolApprovalRequest } from "../../db/schema";
import { createApiError, throwHttpError } from "../../lib/errors";
import type { GrantApprovalRequest } from "../../schemas/approvals";
import { ERROR_CODES } from "../../schemas/errors";
import { failedToolOutput } from "../ai/approval-pending";
import { findToolCallIdForApproval } from "../ai/find-tool-call-by-approval";
import { updateToolPartOutputByToolCallId } from "../ai/update-tool-part-output";
import {
  claimGrantedApproval,
  markFailedApproval,
  releaseClaimedApproval,
} from "./claim";
import { approvalFailureReason } from "./failure-reason";
import { getApprovalForCaller } from "./get-by-id";
import { APPROVAL_KIND_HANDLERS } from "./kinds";

/**
 * Rewrite the persisted tool part from its `{ status: "approval_pending" }`
 * placeholder to the row's current outcome. Idempotent: `find` returns
 * undefined once the part was already mutated, and we no-op.
 */
const substituteToolOutput = async (
  approval: ToolApprovalRequest,
): Promise<void> => {
  const found = await findToolCallIdForApproval({
    conversationId: approval.conversationId,
    approvalId: approval.id,
  });
  if (found === undefined) return;
  // A failed execution has no kind-shaped outcome to report — only a reason —
  // so it bypasses the handler and uses the one shared failure shape.
  const newOutput =
    approval.status === "failed"
      ? failedToolOutput(
          approval.id,
          approval.executionError ?? "Execution failed",
          (approval.decisionAt ?? new Date()).toISOString(),
        )
      : APPROVAL_KIND_HANDLERS[approval.kind].toToolOutput(approval);
  await updateToolPartOutputByToolCallId({
    conversationId: approval.conversationId,
    toolCallId: found.toolCallId,
    newOutput,
  });
};

/**
 * Post-decision orchestration shared by the `/approvals/:id/*` handlers, for
 * every kind.
 *
 * On grant the caller no longer just flips status — it EXECUTES the decision
 * (kind-specific) and substitutes the persisted tool output from its
 * placeholder `{ status: "approval_pending", ... }` to its final state. The
 * next agent turn (chat: hidden continuation message; workflow: wait-token
 * resume) then sees the outcome directly in history and never re-calls the
 * tool. Every step is idempotent so a retry lands in the same final state.
 *
 * This is business logic (execution + persistence), so it lives in shared —
 * the API handler just calls it.
 */

/**
 * For a granted approval: claim, execute (per kind), then substitute the
 * persisted tool output. Safe to call multiple times — a `consumed` row
 * reuses its stored `result` and the substitution step is a no-op once the
 * part was already mutated.
 */
export const executeAndMutateForGrant = async (params: {
  approval: ToolApprovalRequest;
  teamId: string;
  decision?: GrantApprovalRequest;
}): Promise<ToolApprovalRequest> => {
  let working = params.approval;

  // Short-circuit: another worker is already mid-execution (page reload /
  // double-click during a long plan). Return now; the frontend polls
  // `GET /approvals/:id` every 2s while `executing`, so the final state
  // still surfaces without blocking this request.
  if (working.status === "executing") {
    return working;
  }

  if (working.status === "granted") {
    const claimed = await claimGrantedApproval(working.id);
    if (claimed === undefined) {
      // Concurrent caller already claimed — re-read.
      working = await getApprovalForCaller(working.id, params.teamId);
    } else {
      working = claimed;
      const handler = APPROVAL_KIND_HANDLERS[working.kind];
      // Some decisions must not execute inside this request — a staged import
      // takes minutes and, more to the point, has to outlive the tab that
      // approved it. The claim above already happened, so the row sits
      // `executing` and whatever `startDeferred` launches owns finishing it.
      if (handler.deferExecution?.(working) === true) {
        try {
          await handler.startDeferred?.({ approval: working });
        } catch (error) {
          // Nothing started, so the claim has to go back — otherwise the row
          // is `executing` with no executor and the user can never retry.
          await releaseClaimedApproval(working.id);
          throw error;
        }
      } else {
        // Execute the decision (per kind). Each handler's `execute` persists
        // the result + marks the row `consumed` internally, so the re-read
        // below sees the final `consumed` row with its `result`.
        try {
          await handler.execute({
            approval: working,
            decision: params.decision,
          });
        } catch (error) {
          // The write threw — a constraint, a type coercion, a dead
          // connection. The claim must be closed HERE: an uncaught throw used
          // to leave the row `executing` with nobody on it, which the hash
          // lookup then served to every retry ("currently executing") without
          // ever opening another card. Marking it `failed` costs the user no
          // wait — the next identical call gets a fresh approval — and keeps
          // the reason where both the card and the agent can read it.
          const message = approvalFailureReason(error);
          const failed = await markFailedApproval(working.id, message);
          await substituteToolOutput(failed ?? working);
          // 409, not 500: the request was well-formed and the decision was
          // recorded — it is the state that changed under it. The reason
          // travels as the message so the card can say what went wrong instead
          // of "Impossible d'approuver".
          return throwHttpError(
            409,
            createApiError(ERROR_CODES.TOOL_APPROVAL_EXECUTION_FAILED, message),
          );
        }
      }
      working = await getApprovalForCaller(working.id, params.teamId);
    }
  }
  if (working.status === "executing") {
    working = await getApprovalForCaller(working.id, params.teamId);
  }

  await substituteToolOutput(working);
  return working;
};

/**
 * For a rejected approval (any kind): no execution, just substitute the
 * persisted tool output to `{ status: "approval_rejected", … }`. Idempotent.
 */
export const mutateForReject = async (
  approval: ToolApprovalRequest,
): Promise<void> => {
  // Release whatever the pending decision was holding (a refused import's
  // staged rows), before the tool part stops pointing at it.
  await APPROVAL_KIND_HANDLERS[approval.kind].onReject?.(approval);

  const found = await findToolCallIdForApproval({
    conversationId: approval.conversationId,
    approvalId: approval.id,
  });
  if (found !== undefined) {
    await updateToolPartOutputByToolCallId({
      conversationId: approval.conversationId,
      toolCallId: found.toolCallId,
      newOutput: {
        status: "approval_rejected",
        approvalId: approval.id,
        feedback: approval.decisionFeedback ?? undefined,
        rejectedAt: (approval.decisionAt ?? new Date()).toISOString(),
      },
    });
  }
};
