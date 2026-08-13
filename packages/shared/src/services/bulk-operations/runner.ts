import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import type {
  BulkOperation,
  BulkOperationProgress,
  BulkOperationStatus,
} from "../../db/schema";
import { bulkOperationChunks, bulkOperations } from "../../db/schema";
import { publishConversationTaskResume } from "../../lib/conversation-task-resume";
import { findToolCallIdForApproval } from "../ai/find-tool-call-by-approval";
import { updateToolPartOutputByToolCallId } from "../ai/update-tool-part-output";
import { markConsumed } from "../approvals/complete";
import { completeConversationTask } from "../conversation-tasks/complete";
import { updateConversationTaskProgress } from "../conversation-tasks/progress";
import { listPendingChunks } from "./begin";
import { applyChunk } from "./chunk";
import { emptyProgress, foldChunkProgress } from "./progress";
import { BULK_OPERATION_EXECUTORS } from "./registry";
import { importToolOutput } from "./tool-output";

/**
 * Drain a granted operation, chunk by chunk.
 *
 * Restartable at any point without special handling: the chunk ledger is the
 * cursor, so a worker that dies at chunk 57 of 100 resumes at 57, and the
 * progress is recomputed from the ledger rather than carried in memory. That is
 * the property the whole design exists for — the user closed the tab, and this
 * must finish anyway.
 *
 * A chunk that raises stops the drain and re-raises, so BullMQ's retry policy
 * (not a hand-rolled loop) decides when to come back; nothing is lost because
 * the applied chunks are stamped. Per-ROW failures are not chunk failures: they
 * ride in the progress tally, exactly like a small bulk write's `errors`.
 */
export const drainBulkOperation = async (
  operationId: string,
): Promise<BulkOperation> => {
  const operation = await claimRunning(operationId);
  if (operation === null) {
    // Already terminal (a duplicate job, a retry after the finish) — nothing
    // to do, and the caller must not treat that as a failure.
    const row = await db.query.bulkOperations.findFirst({
      where: { id: operationId },
    });
    if (row === undefined)
      throw new Error(`Bulk operation ${operationId} gone`);
    return row;
  }

  let progress = await rebuildProgress(operationId);

  for (const chunk of await listPendingChunks(operationId)) {
    const outcome = await applyChunk({
      operation,
      chunk,
      items: chunk.items ?? [],
    });
    progress = foldChunkProgress(
      progress,
      outcome,
      chunk.chunkIndex * operation.chunkSize,
    );
    // ONE write per chunk, on the row the chat already polls. The operation's
    // own `progress` is NOT written here: nothing reads it before the end
    // (a resume recomputes from the ledger, see `rebuildProgress`), so a
    // second UPDATE per chunk would buy a value no one looks at.
    await updateConversationTaskProgress({
      kind: "bulk_operation",
      ref: operationId,
      done: progress.processed,
      total: operation.totalItems,
    }).catch(() => undefined);
  }

  return finishBulkOperation({ operation, progress, status: "done" });
};

/** Persist the running tally — what the pending-tasks strip polls. */
export const updateBulkOperationProgress = async (
  operationId: string,
  progress: BulkOperationProgress,
): Promise<void> => {
  await db
    .update(bulkOperations)
    .set({ progress })
    .where(eq(bulkOperations.id, operationId));
};

/**
 * `queued` | `running` → `running`. Returns null when the row is already
 * terminal, which is how a duplicate job or a post-finish retry becomes a
 * no-op instead of a second drain.
 */
const claimRunning = async (
  operationId: string,
): Promise<BulkOperation | null> => {
  const [row] = await db
    .update(bulkOperations)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(bulkOperations.id, operationId),
        inArray(bulkOperations.status, ["queued", "running"]),
      ),
    )
    .returning();
  return row ?? null;
};

/**
 * Recompute the tally from the ledger rather than trusting the stored one.
 *
 * A crash can leave `progress` describing fewer chunks than were actually
 * stamped (the chunk UPDATE and the operation UPDATE are separate writes), and
 * a resumed drain that trusted the stored value would under-report the load
 * forever. The ledger is the only durable truth about what landed.
 */
const rebuildProgress = async (
  operationId: string,
): Promise<BulkOperationProgress> => {
  const rows = await db.query.bulkOperationChunks.findMany({
    where: { operationId },
    columns: { chunkIndex: true, result: true, appliedAt: true },
    orderBy: { chunkIndex: "asc" },
  });
  const operation = await db.query.bulkOperations.findFirst({
    where: { id: operationId },
    columns: { chunkSize: true },
  });
  const chunkSize = operation?.chunkSize ?? 0;

  let progress = emptyProgress();
  for (const row of rows) {
    if (row.appliedAt === null || row.result === null) continue;
    progress = foldChunkProgress(
      progress,
      row.result,
      row.chunkIndex * chunkSize,
    );
  }
  return progress;
};

/**
 * Give up on an operation, from outside the drain.
 *
 * The case this exists for: the queue exhausted its retries. Without it the row
 * stays `running` forever, and because a `running` operation is "still going"
 * as far as the wait registry is concerned, its task stays pending — which
 * blocks the conversation's fan-in permanently, for every later task too. A
 * load that will never finish has to SAY so.
 *
 * The tally is rebuilt from the ledger first, so the report keeps whatever did
 * land instead of throwing it away with the failure.
 */
export const failBulkOperation = async (
  operationId: string,
  error: string,
): Promise<void> => {
  const operation = await db.query.bulkOperations.findFirst({
    where: { id: operationId },
  });
  if (operation === undefined) return;
  if (operation.status !== "queued" && operation.status !== "running") return;
  await finishBulkOperation({
    operation,
    progress: await rebuildProgress(operationId),
    status: "failed",
    error,
  });
};

/**
 * Close an operation and tell everyone who was waiting.
 *
 * Two things sit outside the transaction below, each for its own reason: the
 * index build, which Postgres refuses to run inside one, and the resume signal,
 * which must not reach a subscriber before the state it describes is visible.
 * Everything in between commits together — see the transaction's own note.
 */
export const finishBulkOperation = async (input: {
  operation: BulkOperation;
  progress: BulkOperationProgress;
  status: Extract<BulkOperationStatus, "done" | "failed" | "cancelled">;
  error?: string;
}): Promise<BulkOperation> => {
  const { operation } = input;

  if (input.status === "done") {
    // Build the type's field indexes once, now that the whole load is in.
    // Fire-and-forget, and OUTSIDE any transaction, for two separate reasons:
    // `CREATE INDEX CONCURRENTLY` cannot run inside one at all, and the rows
    // are readable without it — making the user's notification wait on an
    // index build would delay "your import is done" by the housekeeping.
    void BULK_OPERATION_EXECUTORS[operation.kind]
      .finalize(operation)
      .catch((cause: unknown) => {
        console.warn(
          `[bulk-operations] finalize failed for ${operation.id}:`,
          cause instanceof Error ? cause.message : cause,
        );
      });
  }

  // ONE transaction, because "the load is over" has to become true across four
  // tables at once. A crash between any two of these writes is a lasting
  // failure, not a hiccup: an operation marked terminal whose task stayed
  // pending blocks that conversation's fan-in FOREVER — and with it every
  // later task — while an approval left `executing` makes a re-run of the
  // agent's code report "currently executing" instead of replaying the result.
  const { finished, wake } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(bulkOperations)
      .set({
        status: input.status,
        progress: input.progress,
        finishedAt: new Date(),
        ...(input.error ? { error: input.error } : {}),
      })
      .where(eq(bulkOperations.id, operation.id))
      .returning();
    const finished = row ?? operation;

    if (input.status === "done") {
      // The ledger has done its job. Its rows were the exactly-once guard
      // while the load ran and nothing reads them afterwards — the counters
      // and the first failures live on the operation, which stays as the
      // durable record. Dropped only on success: a FAILED operation keeps its
      // ledger, because that is what a re-queue resumes from.
      await tx
        .delete(bulkOperationChunks)
        .where(eq(bulkOperationChunks.operationId, finished.id));
    }

    if (finished.approvalId !== null) {
      // The grant deferred execution and left the row `executing`; this is
      // what finally consumes it, so a re-run of the agent's code replays.
      await markConsumed(finished.approvalId, [], tx);
      const found = await findToolCallIdForApproval({
        conversationId: finished.conversationId,
        approvalId: finished.approvalId,
      });
      if (found !== undefined) {
        await updateToolPartOutputByToolCallId({
          conversationId: finished.conversationId,
          toolCallId: found.toolCallId,
          newOutput: importToolOutput(finished, input.progress),
          tx,
        });
      }
    }

    const { transitioned, conversationId } = await completeConversationTask({
      kind: "bulk_operation",
      ref: finished.id,
      status: input.status === "done" ? "succeeded" : "failed",
      tx,
    });
    return {
      finished,
      wake: transitioned ? conversationId : null,
    };
  });

  // After the commit, never inside it: a subscriber woken by this signal reads
  // the database immediately, and would find the load still in flight.
  if (wake !== null) await publishConversationTaskResume(wake);

  return finished;
};
