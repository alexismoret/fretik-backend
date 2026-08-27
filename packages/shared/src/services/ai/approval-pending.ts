/**
 * The pause marker every approval-raising tool emits — `python` (a `run_plan`
 * external-app plan or a gated `records.bulk_*` write) and the workflow
 * `askUserQuestion`. Returns the approval id when `output` has the shape
 * `{ status: "approval_pending", approvalId }`, else `null`.
 *
 * Match by SHAPE, never by tool name: stop conditions and the run-park detector
 * use this so any kind (present or future) parks the turn without a name allowlist.
 */
export const approvalPendingId = (output: unknown): string | null => {
  if (output === null || typeof output !== "object") return null;
  if (!("status" in output) || output.status !== "approval_pending") {
    return null;
  }
  if (!("approvalId" in output)) return null;
  const id = output.approvalId;
  return typeof id === "string" ? id : null;
};

/**
 * The `approval_deferred` marker a gated tool emits when single-flight blocked
 * its write: ANOTHER approval (read or write) is already pending in this
 * conversation, so this one was NOT created. Deliberately NOT an `approval_*`
 * card status and carrying `blockingApprovalId` (not `approvalId`), so the
 * frontend renders no card — it is a "not executed, wait and re-issue" signal
 * to the model only. Match by SHAPE, like `approvalPendingId`.
 */
export const approvalDeferred = (output: unknown): string | null => {
  if (output === null || typeof output !== "object") return null;
  if (!("status" in output) || output.status !== "approval_deferred") {
    return null;
  }
  if (!("blockingApprovalId" in output)) return null;
  const id = output.blockingApprovalId;
  return typeof id === "string" ? id : null;
};

/**
 * The single canonical note carried by every `approval_granted` tool output.
 *
 * The grant is substituted into the tool result of a sandbox cell that RAISED
 * at the gated call — so every statement after it was skipped. A bare success
 * payload reads as "the whole cell ran", and the model reports work it never
 * submitted. The second half is what makes recovery possible: the gate resolves
 * a `consumed` row by `lookupHash` and replays its cached result, so re-running
 * the identical cell is free of double writes.
 */
export const APPROVAL_GRANTED_NOTE =
  "This outcome covers ONLY the operations listed here. Code that sat after the call that raised did NOT run — re-run the identical cell to finish it; already-approved work replays from cache and never executes twice.";

/** The single canonical tool output for a deferred write — one message so no
 * caller re-derives it. Stops the turn (via the stop condition) and tells the
 * model to wait for the pending review, then re-issue. */
export const deferredToolOutput = (
  blockingApprovalId: string,
): {
  status: "approval_deferred";
  blockingApprovalId: string;
  message: string;
} => ({
  status: "approval_deferred",
  blockingApprovalId,
  message:
    "A review is already pending in this conversation; this operation was NOT executed. Stop and wait for that review to be resolved, then re-issue this operation.",
});
