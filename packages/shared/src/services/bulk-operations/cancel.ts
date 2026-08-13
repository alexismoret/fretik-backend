import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { bulkOperationChunks, bulkOperations } from "../../db/schema";

/**
 * Drop a load the user refused.
 *
 * The chunks go with it, and that is the point: 200 000 rejected rows are
 * ~40 MB of jsonb whose only remaining purpose would be to sit in the staging
 * table forever. The operation row stays, as the audit trail of what was asked
 * for and turned down.
 *
 * Only from a not-yet-started state — a drain in progress is cancelled through
 * its own terminal path, not by pulling the rows out from under it.
 */
export const cancelBulkOperation = async (input: {
  operationId: string;
  reason: string;
}): Promise<void> => {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(bulkOperations)
      .set({
        status: "cancelled",
        error: input.reason,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(bulkOperations.id, input.operationId),
          inArray(bulkOperations.status, ["staging", "pending_approval"]),
        ),
      )
      .returning({ id: bulkOperations.id });
    if (row === undefined) return;

    await tx
      .delete(bulkOperationChunks)
      .where(eq(bulkOperationChunks.operationId, row.id));
  });
};
