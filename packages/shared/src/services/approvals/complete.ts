import { eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import {
  type ToolApprovalRequest,
  type ToolApprovalResult,
  toolApprovalRequests,
} from "../../db/schema";

/**
 * Persist the decision result of an executing approval (per-op for a plan,
 * per-record for a record-write, answers for a question).
 *
 *  - `updatePartialResult` writes the result-so-far while a plan is still in
 *    `executing` — survives a mid-plan crash so a re-run can surface the
 *    partial outcome instead of a silent NULL.
 *  - `markConsumed` transitions `executing` → `consumed` once execution has
 *    completed, finalising the row for idempotent re-reads.
 */
export const updatePartialResult = async (
  id: string,
  result: ToolApprovalResult,
): Promise<void> => {
  await db
    .update(toolApprovalRequests)
    .set({ result })
    .where(eq(toolApprovalRequests.id, id));
};

export const markConsumed = async (
  id: string,
  result: ToolApprovalResult,
  /** Commit with the caller's other writes — a deferred execution finishes an
   * approval, a task and an operation in one step, and half of that landing is
   * a conversation stuck waiting on work that is already over. */
  tx?: Transaction,
): Promise<ToolApprovalRequest | undefined> => {
  const [row] = await (tx ?? db)
    .update(toolApprovalRequests)
    .set({ status: "consumed", result })
    .where(eq(toolApprovalRequests.id, id))
    .returning();
  return row;
};
