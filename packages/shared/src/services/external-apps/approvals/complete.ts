import { eq } from "drizzle-orm";
import db from "../../../db";
import {
  type ToolApprovalOpResult,
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../../db/schema";

/**
 * Persist the per-operation result of an executing plan.
 *
 *  - `updatePartialResult` writes the result-so-far while the plan is
 *    still in `executing` — survives a mid-plan crash so a re-run can
 *    surface the partial outcome instead of a silent NULL.
 *  - `markConsumed` transitions `executing` → `consumed` once every op
 *    has completed, finalising the row for idempotent re-reads.
 */
export const updatePartialResult = async (
  id: string,
  result: ToolApprovalOpResult[],
): Promise<void> => {
  await db
    .update(toolApprovalRequests)
    .set({ result })
    .where(eq(toolApprovalRequests.id, id));
};

export const markConsumed = async (
  id: string,
  result: ToolApprovalOpResult[],
): Promise<ToolApprovalRequest | undefined> => {
  const [row] = await db
    .update(toolApprovalRequests)
    .set({ status: "consumed", result })
    .where(eq(toolApprovalRequests.id, id))
    .returning();
  return row;
};
