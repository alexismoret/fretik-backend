import type { ToolApprovalRequest } from "../../db/schema";
import type { GrantApprovalRequest } from "../../schemas/approvals";
import { findToolCallIdForApproval } from "../ai/find-tool-call-by-approval";
import { updateToolPartOutputByToolCallId } from "../ai/update-tool-part-output";
import { claimGrantedApproval } from "./claim";
import { getApprovalForCaller } from "./get-by-id";
import { APPROVAL_KIND_HANDLERS } from "./kinds";

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
      // Execute the decision (per kind). Each handler's `execute` persists the
      // result + marks the row `consumed` internally, so the re-read below sees
      // the final `consumed` row with its `result`.
      await APPROVAL_KIND_HANDLERS[working.kind].execute({
        approval: working,
        decision: params.decision,
      });
      working = await getApprovalForCaller(working.id, params.teamId);
    }
  }
  if (working.status === "executing") {
    working = await getApprovalForCaller(working.id, params.teamId);
  }

  // Substitute the persisted tool output. Safe even when already mutated —
  // `find` returns undefined in that case and we no-op.
  const found = await findToolCallIdForApproval({
    conversationId: working.conversationId,
    approvalId: working.id,
  });
  if (found !== undefined) {
    await updateToolPartOutputByToolCallId({
      conversationId: working.conversationId,
      toolCallId: found.toolCallId,
      newOutput: APPROVAL_KIND_HANDLERS[working.kind].toToolOutput(working),
    });
  }
  return working;
};

/**
 * For a rejected approval (any kind): no execution, just substitute the
 * persisted tool output to `{ status: "approval_rejected", … }`. Idempotent.
 */
export const mutateForReject = async (
  approval: ToolApprovalRequest,
): Promise<void> => {
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
