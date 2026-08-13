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

  /**
   * True when the grant must NOT run inside the HTTP request that granted it.
   *
   * A staged import is the case this exists for: applying 200 000 rows takes
   * minutes, so executing inline would hold the grant request open, time it
   * out, and — worse — tie the work to a browser that the user is precisely
   * expected to close. When this returns true the orchestrator claims the row
   * (`granted` → `executing`) and calls {@link startDeferred} instead of
   * {@link execute}; whatever that started is responsible for finishing the row.
   */
  deferExecution?(approval: ToolApprovalRequest): boolean;

  /**
   * Hand the claimed approval to whatever will execute it out-of-band. Called
   * only when {@link deferExecution} returned true, and only for the caller
   * that won the claim, so it never starts the same work twice.
   */
  startDeferred?(p: { approval: ToolApprovalRequest }): Promise<void>;

  /**
   * Release whatever the pending decision was holding, after a rejection.
   * Only kinds that park state outside the approval row need it — a refused
   * import otherwise leaves its uploaded rows sitting in the staging table
   * forever.
   */
  onReject?(approval: ToolApprovalRequest): Promise<void>;
}
