import db from "../../db";
import { type ToolApprovalRequest } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";

/**
 * Fetch an approval by ID, scoped to the caller's team. 404 otherwise — never
 * leak another team's approval. Scoping is TEAM-level, not user-level: an
 * approval is a shared decision surface (a workflow run's actor creates it, but
 * any team member monitoring the run may decide it; a collaborative chat's
 * approval is likewise visible to the conversation's team). The auth middleware
 * guarantees the caller belongs to `teamId`; the row's `userId` is provenance
 * (who triggered), and the decider is recorded separately as `decidedByUserId`.
 */
export const getApprovalForCaller = async (
  id: string,
  teamId: string,
): Promise<ToolApprovalRequest> => {
  const row = await db.query.toolApprovalRequests.findFirst({
    where: { id, teamId },
  });
  if (row === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.TOOL_APPROVAL_NOT_FOUND,
      message: "Approval not found",
    });
  }
  return row;
};
