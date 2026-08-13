import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { BulkOperation, BulkOperationChunk } from "../../db/schema";
import { bulkOperationChunks } from "../../db/schema";
import { formatBulkRowError } from "../../lib/db-bulk";
import { BULK_OPERATION_EXECUTORS } from "./registry";
import type { ChunkOutcome } from "./types";

/**
 * Stated once because everything below depends on it: ONE chunk is ONE database
 * transaction. `beginBulkOperation` sizes chunks with the same function the
 * write service uses to size its own (`recordWriteChunkSize`), so a chunk that
 * raises is a chunk that wrote nothing.
 *
 * That equality is what turns the ledger into an exactly-once guard rather than
 * a hint:
 *
 *   attempts += 1  →  apply  →  applied_at = now()          (success)
 *   attempts += 1  →  apply throws  →  attempts -= 1        (nothing written)
 *   attempts += 1  →  process dies                          (unknown)
 *
 * Only the third case leaves `attempts > 0` with `applied_at` NULL, and that
 * chunk is REPORTED, never replayed: for a create import a replay means
 * duplicate records, and duplicating a customer silently is worse than telling
 * the agent which 2 000 rows to check. In practice the window is the few
 * milliseconds between a committed transaction and a one-row UPDATE.
 */

/** Nothing to say about a chunk that was already fully applied. */
export const chunkAlreadyApplied = (chunk: BulkOperationChunk): boolean =>
  chunk.appliedAt !== null;

const INTERRUPTED = (chunkIndex: number, itemCount: number): ChunkOutcome => ({
  succeeded: 0,
  failed: itemCount,
  errors: [
    {
      index: 0,
      error: `Chunk ${chunkIndex.toString()} was interrupted mid-write and cannot be safely replayed (a replay would risk duplicating its rows). Verify this range and re-import it on its own if needed.`,
    },
  ],
});

/**
 * Claim a chunk slot. Returns the ledger row, creating it if this is the first
 * time the caller sends this index.
 *
 * `ON CONFLICT DO NOTHING` is what makes an upload retry a no-op instead of a
 * second copy of 2 000 rows — a dropped response, a sandbox recycle mid-loop, a
 * BullMQ job retry all land here.
 */
export const claimChunk = async (input: {
  operationId: string;
  chunkIndex: number;
  itemCount: number;
  /** Parked rows — `staged` mode only; `direct` applies on arrival. */
  items?: Record<string, unknown>[];
}): Promise<BulkOperationChunk> => {
  await db
    .insert(bulkOperationChunks)
    .values({
      operationId: input.operationId,
      chunkIndex: input.chunkIndex,
      itemCount: input.itemCount,
      ...(input.items ? { items: input.items } : {}),
    })
    .onConflictDoNothing({
      target: [bulkOperationChunks.operationId, bulkOperationChunks.chunkIndex],
    });

  const row = await db.query.bulkOperationChunks.findFirst({
    where: {
      operationId: input.operationId,
      chunkIndex: input.chunkIndex,
    },
  });
  // The insert either landed or conflicted with an existing row, so this is
  // only reachable if the operation was deleted underneath us.
  if (row === undefined) {
    throw new Error(
      `Bulk chunk ${input.chunkIndex.toString()} vanished after claim`,
    );
  }
  return row;
};

/**
 * Apply one claimed chunk, maintaining the ledger around it.
 *
 * Safe to call on any chunk row: already applied → its stored outcome; crashed
 * mid-apply → the interruption report; otherwise the executor runs and the row
 * is stamped. The caller never has to reason about which case it is in.
 */
export const applyChunk = async (input: {
  operation: BulkOperation;
  chunk: BulkOperationChunk;
  /** Rows for this chunk. `direct` passes what it just received; the worker
   * reads the parked `items`. */
  items: Record<string, unknown>[];
}): Promise<ChunkOutcome> => {
  const { operation, chunk } = input;

  if (chunk.appliedAt !== null) {
    return (
      chunk.result ?? { succeeded: chunk.itemCount, failed: 0, errors: [] }
    );
  }

  // Bump first: whatever happens next, the ledger records that a write was
  // started. A clean failure below puts it back.
  const [claimed] = await db
    .update(bulkOperationChunks)
    .set({ attempts: sql`${bulkOperationChunks.attempts} + 1` })
    .where(
      and(
        eq(bulkOperationChunks.id, chunk.id),
        // Someone else may have applied it between the read and here.
        sql`${bulkOperationChunks.appliedAt} IS NULL`,
      ),
    )
    .returning({ attempts: bulkOperationChunks.attempts });

  if (claimed === undefined) {
    const fresh = await db.query.bulkOperationChunks.findFirst({
      where: { id: chunk.id },
    });
    return (
      fresh?.result ?? { succeeded: chunk.itemCount, failed: 0, errors: [] }
    );
  }

  if (claimed.attempts > 1) {
    const outcome = INTERRUPTED(chunk.chunkIndex, chunk.itemCount);
    await stampChunk(chunk.id, outcome);
    return outcome;
  }

  let outcome: ChunkOutcome;
  try {
    outcome = await BULK_OPERATION_EXECUTORS[operation.kind].applyChunk({
      op: operation,
      chunk,
      items: input.items,
    });
  } catch (error) {
    // The transaction rolled back, so nothing landed — hand the attempt back
    // and let the caller decide whether to retry.
    await db
      .update(bulkOperationChunks)
      .set({ attempts: sql`greatest(${bulkOperationChunks.attempts} - 1, 0)` })
      .where(eq(bulkOperationChunks.id, chunk.id));
    throw new Error(
      `Bulk chunk ${chunk.chunkIndex.toString()} failed: ${formatBulkRowError(error)}`,
      { cause: error },
    );
  }

  await stampChunk(chunk.id, outcome);
  return outcome;
};

const stampChunk = async (
  chunkId: string,
  outcome: ChunkOutcome,
): Promise<void> => {
  await db
    .update(bulkOperationChunks)
    .set({
      appliedAt: new Date(),
      result: {
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        // The operation-level tally keeps its own capped list; a chunk keeps
        // only enough to explain itself in the ledger.
        errors: outcome.errors.slice(0, 10),
      },
      // Parked rows are dead weight once written — a 200 000-row import would
      // otherwise leave 40 MB of duplicated jsonb behind forever.
      items: null,
    })
    .where(eq(bulkOperationChunks.id, chunkId));
};
