import { and, eq } from "drizzle-orm";
import db from "../../../db";
import {
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { getApprovalForCaller } from "./get-by-id";

/**
 * User rejects a pending plan with an optional feedback note. The
 * frontend forwards the feedback to the agent as a continuation
 * message; rejected rows are skipped by `findLatestApprovalByHash`, so
 * an agent that re-emits identical code after a rejection creates a
 * fresh `pending` (which the user would presumably also reject — that
 * is by design; the user controls the loop).
 */
export const rejectApproval = async (params: {
  id: string;
  teamId: string;
  userId: string;
  feedback?: string;
}): Promise<ToolApprovalRequest> => {
  const existing = await getApprovalForCaller(
    params.id,
    params.teamId,
    params.userId,
  );

  if (existing.status !== "pending") {
    return throwHttpError(409, {
      code: ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS,
      message: `Cannot reject an approval in status "${existing.status}"`,
    });
  }

  const [row] = await db
    .update(toolApprovalRequests)
    .set({
      status: "rejected",
      decisionAt: new Date(),
      decidedByUserId: params.userId,
      decisionFeedback: params.feedback ?? null,
    })
    .where(
      and(
        eq(toolApprovalRequests.id, params.id),
        eq(toolApprovalRequests.status, "pending"),
      ),
    )
    .returning();

  if (row === undefined) {
    return throwHttpError(409, {
      code: ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS,
      message: "Approval status changed concurrently",
    });
  }
  return row;
};
