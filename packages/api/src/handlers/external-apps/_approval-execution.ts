import type { ToolApprovalRequest } from "@fretik/shared/db/schema";
import { findToolCallIdForApproval } from "@fretik/shared/services/ai/find-tool-call-by-approval";
import { updateToolPartOutputByToolCallId } from "@fretik/shared/services/ai/update-tool-part-output";
import { claimGrantedApproval } from "@fretik/shared/services/external-apps/approvals/claim";
import { getApprovalForCaller } from "@fretik/shared/services/external-apps/approvals/get-by-id";
import { executePlan } from "@fretik/shared/services/external-apps/exec/plan-executor";

/**
 * Post-decision orchestration used by the approval handlers
 * (`/external-apps/approvals/:id/{grant,modify-and-grant,reject}`).
 *
 * Design (cf. plan `j-ai-r-cemment-fait-une-ancient-biscuit.md`): the
 * handlers no longer just update the approval status — they ALSO
 * execute the plan (for grant / modify-and-grant) and substitute the
 * persisted `python` tool output from its placeholder
 * `{ status: "approval_pending", ... }` to its final state
 * (`approval_granted` / `approval_rejected`). The next chatbot turn
 * (triggered by the frontend via `chat.sendMessage` with a hidden
 * metadata trigger) then sees the substituted result directly in
 * the conversation history and never needs to re-call `python`.
 *
 * All operations here are idempotent so a network retry (or the
 * self-heal flow when the user closes the tab between grant and
 * trigger) ends up in the same final state.
 */

/**
 * For a granted approval: claim, execute via Nango, then mute the
 * persisted python tool output to `{ status: "approval_granted",
 * approvalId, result, grantedAt }`. Safe to call multiple times — if
 * the row is already `consumed`, the cached `result` is reused and the
 * mutation step is a no-op (the part was already substituted).
 */
export const executeAndMutateForGrant = async (params: {
  approval: ToolApprovalRequest;
  teamId: string;
  userId: string;
}): Promise<ToolApprovalRequest> => {
  let working = params.approval;

  // Short-circuit: another worker is already mid-execution (typical
  // when the user reloads the page or double-clicks Approve during a
  // long-running plan). Return the current row immediately instead of
  // holding the HTTP connection open for the in-flight execution to
  // finish. The frontend polls `GET /approvals/:id` every 2s while
  // status is `executing`, so the final state still surfaces without
  // blocking this request for ~30s+.
  if (working.status === "executing") {
    return working;
  }

  // 1. Execute (idempotent across status). The dispatch-layer state
  //    machine guarantees a single physical execution per approval
  //    row — claim is atomic, consumed reads its cached result.
  if (working.status === "granted") {
    const claimed = await claimGrantedApproval(working.id);
    if (claimed === undefined) {
      // Concurrent caller already claimed — re-read.
      working = await getApprovalForCaller(
        working.id,
        params.teamId,
        params.userId,
      );
      // Fall through: status is now executing or consumed.
    } else {
      working = claimed;
      await executePlan({
        approval: working,
        teamId: params.teamId,
        userId: params.userId,
      });
      // executePlan calls markConsumed internally — re-read for the
      // final row state (status=consumed, result=…).
      working = await getApprovalForCaller(
        working.id,
        params.teamId,
        params.userId,
      );
    }
  }
  // If we landed in "executing" via a racing claim (claimed === undefined
  // above, then re-read returned `executing`), re-read once more. The
  // early-entry "executing" case is short-circuited at the top of the
  // function. The frontend polling picks up the final state regardless.
  if (working.status === "executing") {
    working = await getApprovalForCaller(
      working.id,
      params.teamId,
      params.userId,
    );
  }

  // 2. Mute the persisted python tool output. Safe even when the part
  //    has already been mutated by a previous call — `find` returns
  //    undefined in that case and we no-op.
  const found = await findToolCallIdForApproval({
    conversationId: working.conversationId,
    approvalId: working.id,
  });
  if (found !== undefined) {
    await updateToolPartOutputByToolCallId({
      conversationId: working.conversationId,
      toolCallId: found.toolCallId,
      newOutput: {
        status: "approval_granted",
        approvalId: working.id,
        result: working.result ?? [],
        grantedAt: (working.decisionAt ?? new Date()).toISOString(),
      },
    });
  }
  return working;
};

/**
 * For a rejected approval: no Nango execution, just substitute the
 * persisted python tool output to `{ status: "approval_rejected",
 * approvalId, feedback, rejectedAt }`. Idempotent.
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
