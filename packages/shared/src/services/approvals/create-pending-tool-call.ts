import db from "../../db";
import {
  type ToolApprovalRequest,
  type ToolApprovalToolCallPayload,
  toolApprovalRequests,
} from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";

/**
 * INSERT a fresh `pending` row for a `tool_call` approval — ONE gated builtin
 * write tool (manageLink / manageDrive / uploadToDrive / manageRecord variants).
 * The payload carries the tool name + already-resolved args; grant applies it
 * via the shared apply map (`services/tool-policies/builtin-apply`).
 *
 * `lookupHash` includes the turnId (unlike the sandbox kinds): the continuation
 * never re-calls the tool — its output is substituted in history — so scoping by
 * turn stops a later identical call from replaying a stale consumed result.
 */
export const createPendingToolCallApproval = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
  lookupHash: string;
  payload: ToolApprovalToolCallPayload;
}): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.userId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      kind: "tool_call",
      lookupHash: params.lookupHash,
      payload: params.payload,
      itemCount: 1,
      status: "pending",
    })
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to insert pending tool-call approval",
    });
  }
  return row;
};
