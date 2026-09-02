import db from "../../db";
import { type ToolApprovalRequest } from "../../db/schema";

/**
 * Most recent LIVE approval matching `(conversationId, lookupHash)`.
 *
 * `rejected` and `failed` are the two terminal states a retry is allowed to
 * move past, so both are skipped: an agent re-emitting the same plan after a
 * refusal — or after an execution error — starts a fresh `pending` instead of
 * being answered by the dead row. (Skipping `failed` is what keeps an
 * infrastructure error from making one operation permanently unapprovable.)
 *
 * Used by the dispatcher to route a plan submission to the right state:
 *  - `pending`   → return `approval_pending` (no duplicate row).
 *  - `granted`   → claim atomically to `executing`, then run.
 *  - `executing` → explicit error with the partial `result` (or, past the
 *                  staleness window on an inline kind, fail it and start over).
 *  - `consumed`  → return the cached `result` (idempotent re-run).
 *  - undefined   → INSERT a fresh `pending`.
 */
export const findLatestApprovalByHash = async (params: {
  conversationId: string;
  lookupHash: string;
}): Promise<ToolApprovalRequest | undefined> =>
  db.query.toolApprovalRequests.findFirst({
    where: {
      conversationId: params.conversationId,
      lookupHash: params.lookupHash,
      status: { notIn: ["rejected", "failed"] },
    },
    orderBy: { createdAt: "desc" },
  });

/**
 * Every `pending` row in a conversation, oldest first. The single-flight guard
 * in `runApprovalGate` uses this to enforce ONE pending approval per
 * conversation: kind-agnostic (a pending read blocks a later write and vice
 * versa) and NULL-`lookupHash`-safe (a pending `question` still counts), which
 * a `lookupHash <> …` filter would silently miss.
 */
export const findPendingApprovals = async (
  conversationId: string,
): Promise<ToolApprovalRequest[]> =>
  db.query.toolApprovalRequests.findMany({
    where: {
      conversationId,
      status: "pending",
    },
    orderBy: { createdAt: "asc" },
  });
