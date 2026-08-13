import { and, eq } from "drizzle-orm";
import db from "../../db";
import {
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../db/schema";

/**
 * Atomically transition a `granted` approval to `executing`. Returns the
 * row when the transition succeeds, or `undefined` when the row was no
 * longer `granted` (already executing/consumed by a concurrent dispatch
 * call). The caller then re-reads to decide what to surface — most
 * likely `EXTERNAL_APP_PLAN_EXECUTING` for an in-flight peer call, or
 * the cached `result` for a consumed one.
 *
 * Closes the crash window between "consume the grant" and "store the
 * result" — `result` is then written incrementally by the plan executor.
 */
export const claimGrantedApproval = async (
  id: string,
): Promise<ToolApprovalRequest | undefined> => {
  const [row] = await db
    .update(toolApprovalRequests)
    .set({ status: "executing", executedAt: new Date() })
    .where(
      and(
        eq(toolApprovalRequests.id, id),
        eq(toolApprovalRequests.status, "granted"),
      ),
    )
    .returning();
  return row;
};

/**
 * Hand a claim back: `executing` → `granted`.
 *
 * Only for a deferred grant whose hand-off failed before anything started.
 * `executing` means "someone is working on this", and a row stuck there with
 * nobody working on it is a dead end — the status machine deliberately refuses
 * to re-execute it. Reverting lets the user simply try again.
 */
export const releaseClaimedApproval = async (id: string): Promise<void> => {
  await db
    .update(toolApprovalRequests)
    .set({ status: "granted", executedAt: null })
    .where(
      and(
        eq(toolApprovalRequests.id, id),
        eq(toolApprovalRequests.status, "executing"),
      ),
    );
};
