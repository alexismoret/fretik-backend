import db from "../../db";
import { type ToolApprovalRequest } from "../../db/schema";

/**
 * Most recent non-rejected approval matching `(conversationId, lookupHash)`.
 * Rejected rows are intentionally skipped so an agent that re-emits the
 * same plan after a rejection starts a fresh `pending`.
 *
 * Used by the dispatcher to route a plan submission to the right state:
 *  - `pending`   → return `approval_pending` (no duplicate row).
 *  - `granted`   → claim atomically to `executing`, then run.
 *  - `executing` → explicit error with the partial `result`.
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
      status: { ne: "rejected" },
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
