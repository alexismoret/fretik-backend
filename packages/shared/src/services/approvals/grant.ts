import { and, eq } from "drizzle-orm";
import db from "../../db";
import {
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import { getApprovalForCaller } from "./get-by-id";

/**
 * User approves a pending plan. Only valid from `pending`; any other
 * status returns `TOOL_APPROVAL_WRONG_STATUS` so a stale UI click on an
 * already-granted/executed plan doesn't silently no-op.
 */
export const grantApproval = async (params: {
  id: string;
  teamId: string;
  userId: string;
}): Promise<ToolApprovalRequest> => {
  const existing = await getApprovalForCaller(params.id, params.teamId);

  if (existing.status !== "pending") {
    return throwHttpError(409, {
      code: ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS,
      message: `Cannot grant an approval in status "${existing.status}"`,
    });
  }

  const [row] = await db
    .update(toolApprovalRequests)
    .set({
      status: "granted",
      decisionAt: new Date(),
      decidedByUserId: params.userId,
    })
    .where(
      and(
        eq(toolApprovalRequests.id, params.id),
        eq(toolApprovalRequests.status, "pending"),
      ),
    )
    .returning();

  if (row === undefined) {
    // Concurrent decision — re-read and report the new status.
    return throwHttpError(409, {
      code: ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS,
      message: "Approval status changed concurrently",
    });
  }
  return row;
};
