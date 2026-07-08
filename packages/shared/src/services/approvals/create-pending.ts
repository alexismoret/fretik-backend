import db from "../../db";
import {
  type ToolApprovalOperation,
  type ToolApprovalRequest,
  type ToolApprovalSummary,
  toolApprovalRequests,
} from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";

/**
 * INSERT a fresh `pending` row for a plan submission. Called by the
 * dispatcher when `findLatestApprovalByHash` returned `undefined`.
 *
 * No `expires_at` — pending approvals never expire (a user can come back
 * 3 days later, click Approve, and the same lookupHash matches their
 * agent's re-run).
 */
export const createPendingApproval = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
  lookupHash: string;
  operations: ToolApprovalOperation[];
  summary: ToolApprovalSummary;
}): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.userId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      lookupHash: params.lookupHash,
      operations: params.operations,
      itemCount: params.operations.length,
      summary: params.summary,
      status: "pending",
    })
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to insert pending approval",
    });
  }
  return row;
};
