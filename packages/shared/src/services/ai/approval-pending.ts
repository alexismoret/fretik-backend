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
