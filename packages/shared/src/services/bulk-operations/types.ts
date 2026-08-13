import type {
  BulkOperation,
  BulkOperationChunk,
  BulkOperationKind,
  ToolApprovalRecordImportPayload,
} from "../../db/schema";

/** What applying one chunk produced. Indexes are LOCAL to the chunk. */
export interface ChunkOutcome {
  succeeded: number;
  failed: number;
  errors: { index: number; error: string }[];
  /**
   * New record ids, aligned with the chunk's items — `direct` mode only, where
   * the caller is still holding the request and its SDK contract promises them.
   * The worker path has nobody to hand them to and omits it.
   */
  ids?: (string | null)[];
}

/**
 * Per-kind strategy for a bulk operation, in the same spirit as
 * `APPROVAL_KIND_HANDLERS`: the runner, the upload path and the approval gate
 * all dispatch through `BULK_OPERATION_EXECUTORS[kind]` and never branch on the
 * kind themselves.
 *
 * An executor only ever sees the persisted rows, so the same code serves an
 * inline apply (inside the upload request) and a worker drain hours later.
 */
export interface BulkOperationExecutor {
  kind: BulkOperationKind;

  /**
   * Validate the operation's `sample` before a human is asked to grant it. A
   * malformed load must bounce back to the agent — which can fix its mapping
   * and resubmit — rather than reach a person who cannot act on it. Runs once,
   * on the sample only: validating 200 000 rows to decide whether to show a
   * card would cost the whole import twice.
   */
  validateSample(
    op: BulkOperation,
  ): Promise<{ index: number; error: string }[]>;

  /** Apply ONE chunk. Must be safe to call exactly once per chunk row. */
  applyChunk(p: {
    op: BulkOperation;
    chunk: BulkOperationChunk;
    /** `direct` mode passes the rows it just received; the worker reads them
     * from the chunk row. */
    items: Record<string, unknown>[];
  }): Promise<ChunkOutcome>;

  /** After the LAST chunk — index reconcile, file finalization, etc. */
  finalize(op: BulkOperation): Promise<void>;

  /** The approval card's payload — `staged` mode only. */
  buildApprovalPayload(
    op: BulkOperation,
  ): Promise<ToolApprovalRecordImportPayload>;

  /** One line for the pending-tasks strip and the resume message. */
  describe(op: BulkOperation): string;
}
