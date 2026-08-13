import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import type { BulkOperation } from "../../db/schema";
import { bulkOperations } from "../../db/schema";
import { registerConversationTask } from "../conversation-tasks/register";
import { enqueueBulkOperation } from "./queue";
import { BULK_OPERATION_EXECUTORS } from "./registry";

/**
 * Hand a granted operation to the background worker.
 *
 * The status flip and the wait registration commit TOGETHER, on purpose: a
 * `queued` operation nobody is waiting on would finish into silence — the tab
 * is already closed, and the wait row is the only thing that will wake the
 * conversation. `createWorkflowRun` registers inside its own transaction for
 * the same reason.
 *
 * The enqueue comes after the commit rather than inside it: a job that starts
 * before the row is visible would find a `pending_approval` operation and
 * no-op. Should the enqueue then fail, the operation sits `queued` with a
 * pending wait row — the state the sweep is there to reconcile.
 */
export const startBulkOperation = async (
  operation: BulkOperation,
): Promise<BulkOperation | null> => {
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(bulkOperations)
      .set({ status: "queued" })
      .where(
        and(
          eq(bulkOperations.id, operation.id),
          // Only from a decided-but-not-started state. A retried grant, or a
          // second tab clicking approve, lands on a `queued`/`running` row and
          // gets nothing back — one drain, not two.
          inArray(bulkOperations.status, ["pending_approval"]),
        ),
      )
      .returning();
    if (row === undefined) return null;

    await registerConversationTask({
      tx,
      conversationId: row.conversationId,
      kind: "bulk_operation",
      ref: row.id,
      // `title` is the durable, human-readable fallback (lists, audit); the
      // chat row composes its own label from the metadata so every displayed
      // word goes through i18n.
      title: BULK_OPERATION_EXECUTORS[row.kind].describe(row),
      metadata: {
        importTypeKey: row.params.typeKey,
        importRows: row.totalItems,
      },
    });
    return row;
  });

  if (claimed === null) return null;
  await enqueueBulkOperation(claimed.id);
  return claimed;
};
