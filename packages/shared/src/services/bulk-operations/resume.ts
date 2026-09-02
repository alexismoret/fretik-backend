import { and, eq, isNull, sql } from "drizzle-orm";
import db from "../../db";
import type { BulkOperation } from "../../db/schema";
import { bulkOperationChunks, bulkOperations } from "../../db/schema";
import { reopenConversationTask } from "../conversation-tasks/reopen";
import { enqueueBulkOperation } from "./queue";

/**
 * How many times one load may be picked back up after a failed drain.
 *
 * The bound is on repetition, not on effort: BullMQ has already retried the
 * failing chunk its own several times before the operation was marked failed,
 * so a cause that survives a resume is a cause that is not going away. Past
 * this, the honest answer is the reason itself — the rows have to change,
 * which changes the hash and is a new load by definition.
 */
export const MAX_BULK_OPERATION_RESUMES = 2;

/** Chunks of this operation that were never applied. */
const countUnappliedChunks = async (operationId: string): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bulkOperationChunks)
    .where(
      and(
        eq(bulkOperationChunks.operationId, operationId),
        isNull(bulkOperationChunks.appliedAt),
      ),
    );
  return row?.n ?? 0;
};

export type ResumeOutcome =
  /** Re-queued; the worker picks it up. */
  | { state: "resumed"; operation: BulkOperation; remainingChunks: number }
  /** Every chunk had in fact landed — the load is materially complete. */
  | { state: "nothing_left" }
  /** Refused, with the reason to give back. */
  | { state: "refused"; reason: string };

/**
 * Pick a failed load back up where its ledger stopped.
 *
 * A staged import is the one write in the system that can be half-done: the
 * chunk ledger stamps what was applied, so the remaining chunks — and only
 * those — can be drained later. That property was built and then never used:
 * a failed operation kept its ledger "for a re-queue" that nothing exposed, so
 * the agent re-running its code met a permanent refusal and the user's
 * half-imported table had no way forward but a different file.
 *
 * No new approval card. The user granted THIS load, the grant was spent on
 * work that was interrupted, and the ledger guarantees a resumed drain writes
 * only what the grant already covered. Asking again would be asking about the
 * same rows, and — with one pending approval allowed per conversation — would
 * cost another round-trip through the user to say yes twice.
 *
 * Mirrors `startBulkOperation`: the status flip and the wait registration
 * commit together, and the enqueue comes after the commit so the job cannot
 * find a row that is not visible yet.
 */
export const resumeBulkOperation = async (
  operation: BulkOperation,
): Promise<ResumeOutcome> => {
  // Only a failed drain is resumable. `cancelled` above all: the callers
  // answer that one themselves, in the user's terms, and reaching here with it
  // means a caller forgot — so say which status was refused rather than
  // replaying `error`, which on a cancelled row still describes the drain that
  // came before the cancellation.
  if (operation.status !== "failed") {
    return {
      state: "refused",
      reason: `This load is ${operation.status}; only a failed one can be resumed.`,
    };
  }
  if (operation.resumeCount >= MAX_BULK_OPERATION_RESUMES) {
    return {
      state: "refused",
      reason: `${operation.error ?? "The load failed."} It has already been resumed ${operation.resumeCount.toString()} times and keeps failing the same way — this will not clear by retrying. Fix the cause, or change the rows (which makes it a new load).`,
    };
  }

  const remainingChunks = await countUnappliedChunks(operation.id);
  if (remainingChunks === 0) return { state: "nothing_left" };

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(bulkOperations)
      .set({
        status: "queued",
        error: null,
        finishedAt: null,
        resumeCount: operation.resumeCount + 1,
      })
      // Only from `failed`: a concurrent resume, or a sweep that re-queued it
      // first, must not produce a second drain of the same chunks.
      .where(
        and(
          eq(bulkOperations.id, operation.id),
          eq(bulkOperations.status, "failed"),
        ),
      )
      .returning();
    if (row === undefined) return null;

    // The conversation waited on this load, was told it failed, and must wait
    // again — otherwise the drain settles an already-terminal task, nothing
    // transitions, and the finish wakes nobody.
    await reopenConversationTask({
      tx,
      kind: "bulk_operation",
      ref: operation.id,
    });
    return row;
  });

  if (claimed === null) {
    return {
      state: "refused",
      reason:
        "The load was already picked up by another attempt — wait for it.",
    };
  }

  await enqueueBulkOperation(claimed.id);
  return { state: "resumed", operation: claimed, remainingChunks };
};
