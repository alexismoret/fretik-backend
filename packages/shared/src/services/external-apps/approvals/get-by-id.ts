import db from "../../../db";
import { type ToolApprovalRequest } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";

/**
 * Fetch an approval by ID and check the caller may see it: same team
 * AND same user (the user who initiated the agent turn). 404 otherwise
 * — never leak the existence of another user's approval.
 */
export const getApprovalForCaller = async (
  id: string,
  teamId: string,
  userId: string,
): Promise<ToolApprovalRequest> => {
  const row = await db.query.toolApprovalRequests.findFirst({
    where: { id, teamId, userId },
  });
  if (row === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.TOOL_APPROVAL_NOT_FOUND,
      message: "Approval not found",
    });
  }
  return row;
};
