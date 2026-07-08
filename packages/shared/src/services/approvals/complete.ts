import { eq } from "drizzle-orm";
import db from "../../db";
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
): Promise<ToolApprovalRequest | undefined> => {
  const [row] = await db
    .update(toolApprovalRequests)
    .set({ status: "consumed", result })
    .where(eq(toolApprovalRequests.id, id))
    .returning();
  return row;
};
