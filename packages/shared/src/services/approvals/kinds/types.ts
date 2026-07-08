import type {
  ToolApprovalKind,
  ToolApprovalRequest,
  ToolApprovalResult,
} from "../../../db/schema";
import type { GrantApprovalRequest } from "../../../schemas/approvals";

/**
 * Per-kind strategy for the unified approval domain. The generic gate
 * (`gate.ts`) and the human-decision orchestrator (`execute-decision.ts`) both
 * dispatch through `APPROVAL_KIND_HANDLERS[kind]` — the kind never leaks a
 * `switch` into either. A handler operates only on the persisted
 * `ToolApprovalRequest` row (uniform across kinds); the producer-specific parts
 * (dedup hash, pending-row creation) stay as closures the producer passes into
 * the gate.
 */
export interface ApprovalKindHandler {
  kind: ToolApprovalKind;

  /**
   * Execute a CLAIMED (`executing`) approval — the write itself for
   * `external_app_plan` / `record_write`, or answer capture for `question`.
   * Persists `result` and flips the row to `consumed` internally. Shared by the
   * gate (autonomous auto-grant / granted re-run on the sandbox path) and the
   * human grant orchestrator. `decision` carries the grant-time choices
   * (`selectedIndexes` for record_write, `answers` for question).
   */
  execute(p: {
    approval: ToolApprovalRequest;
    decision?: GrantApprovalRequest;
  }): Promise<ToolApprovalResult>;

  /**
   * The substituted tool-part output written after a human decision, so the
   * next agent turn sees the outcome in history and never re-calls the tool.
   */
  toToolOutput(approval: ToolApprovalRequest): unknown;

  /**
   * The `data` returned to the sandbox SDK on `{status:"ok"}` — the SAME wire
   * shape the direct (autonomous/chat) path returns, so a re-run of the gated
   * code behaves identically and replays the cache. Optional: `question` never
   * reaches the sandbox gate.
   */
  toSandboxData?(
    approval: ToolApprovalRequest,
    result: ToolApprovalResult,
  ): unknown;
}
