import type { BulkOperation, BulkOperationProgress } from "../../db/schema";

/**
 * What the agent reads about a staged load — as the substituted tool part after
 * a grant, as the sandbox's replay `data`, and as the numbers the resume
 * message quotes. One shape, so those three never disagree.
 *
 * Deliberately NOT the `{ids: [...]}` a small `bulk_create` returns: at this
 * size the caller is holding 200 000 rows it cannot correlate anyway, and
 * pretending otherwise would put a 7 MB array on a path that exists precisely
 * to keep large data out of the agent's way. Counters and the first failures
 * are what a person — or an agent — can act on.
 */
export const importToolOutput = (
  operation: BulkOperation,
  progress: BulkOperationProgress | null,
): Record<string, unknown> => {
  const tally = progress ?? operation.progress;
  const head = {
    status: operation.status,
    operationId: operation.id,
    total: operation.totalItems,
    ...(operation.error !== null ? { error: operation.error } : {}),
  };
  // While the load is still moving there are no counts to give — the
  // operation's own tally is only written when it ends, and reporting
  // `okCount: 0` next to `status: "running"` reads as "nothing landed" to
  // a model. Silence is the honest answer until it finishes.
  if (tally === null) return head;
  return {
    ...head,
    okCount: tally.succeeded,
    failedCount: tally.failed,
    // Capped list plus the true total, so "3 errors shown" never reads as
    // "3 errors happened".
    errors: tally.errors,
    errorCount: tally.errorCount,
  };
};
