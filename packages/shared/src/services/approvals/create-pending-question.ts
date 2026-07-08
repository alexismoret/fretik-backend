import db from "../../db";
import {
  type ToolApprovalQuestionPayload,
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";

/**
 * INSERT a fresh `pending` row for a `question` approval — a structured
 * question the workflow executor raised via `askUserQuestion`. No
 * operations / summary / lookupHash: the card renders from `payload`, and
 * grant records the answers without executing anything.
 */
export const createPendingQuestionApproval = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
  payload: ToolApprovalQuestionPayload;
}): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.userId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      kind: "question",
      payload: params.payload,
      itemCount: params.payload.questions.length,
      status: "pending",
    })
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to insert pending question approval",
    });
  }
  return row;
};
