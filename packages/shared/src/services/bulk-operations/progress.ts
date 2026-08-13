import {
  BULK_OPERATION_ERROR_LIMIT,
  type BulkOperationProgress,
} from "../../db/schema";

/** A fresh, zeroed tally. */
export const emptyProgress = (): BulkOperationProgress => ({
  processed: 0,
  succeeded: 0,
  failed: 0,
  errorCount: 0,
  errors: [],
});

/**
 * Fold one chunk's outcome into the running tally.
 *
 * Pure and associative on purpose: the same function serves the inline path
 * (chunk applied in the upload request) and the worker drain, and both may
 * re-fold from the chunk ledger after a restart. `errorCount` keeps counting
 * past {@link BULK_OPERATION_ERROR_LIMIT} while `errors` stops growing — a load
 * where every row is malformed must be able to say "180 000 failed" without
 * storing 180 000 messages.
 *
 * `offset` turns the chunk's local indexes into row numbers in the caller's
 * original list, which is the only form an agent can act on.
 */
export const foldChunkProgress = (
  base: BulkOperationProgress,
  chunk: {
    succeeded: number;
    failed: number;
    errors: { index: number; error: string }[];
  },
  offset: number,
): BulkOperationProgress => {
  const room = Math.max(0, BULK_OPERATION_ERROR_LIMIT - base.errors.length);
  return {
    processed: base.processed + chunk.succeeded + chunk.failed,
    succeeded: base.succeeded + chunk.succeeded,
    failed: base.failed + chunk.failed,
    errorCount: base.errorCount + chunk.errors.length,
    errors: [
      ...base.errors,
      ...chunk.errors
        .slice(0, room)
        .map((e) => ({ index: offset + e.index, error: e.error })),
    ],
  };
};
