import db from "../../db";
import {
  type ToolApprovalRecordWritePayload,
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";

/**
 * INSERT a fresh `pending` row for a `record_write` approval — one gated bulk
 * object write (create / update / delete) the workflow executor issued through
 * the Python `objects` SDK. The card renders each item (selectable); grant
 * re-executes the approved subset via the bulk services. `lookupHash` freezes
 * the write so an identical re-run of the agent's code matches the grant.
 */
export const createPendingRecordWriteApproval = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
  lookupHash: string;
  payload: ToolApprovalRecordWritePayload;
}): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: params.userId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      kind: "record_write",
      lookupHash: params.lookupHash,
      payload: params.payload,
      itemCount: params.payload.items.length,
      status: "pending",
    })
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to insert pending record-write approval",
    });
  }
  return row;
};
