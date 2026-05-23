import { and, eq } from "drizzle-orm";
import db from "../../../db";
import {
  type ToolApprovalOperation,
  type ToolApprovalRequest,
  type ToolApprovalSummary,
  toolApprovalRequests,
} from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { getApprovalForCaller } from "./get-by-id";

/**
 * User edits some operations of a pending plan then approves. The
 * `lookupHash` stays frozen — only the executable `operations` and the
 * `summary` change. On re-run the agent's identical code matches the
 * frozen hash and the dispatcher executes the modified operations
 * (which were exactly what the user saw and approved on the card).
 *
 * The caller must validate each modified op against its manifest before
 * calling here — usually done in the API handler with the same Zod
 * schemas dispatch uses.
 */
export const modifyAndGrantApproval = async (params: {
  id: string;
  teamId: string;
  userId: string;
  operations: ToolApprovalOperation[];
  summary: ToolApprovalSummary;
}): Promise<ToolApprovalRequest> => {
  const existing = await getApprovalForCaller(
    params.id,
    params.teamId,
    params.userId,
  );

  if (existing.status !== "pending") {
    return throwHttpError(409, {
      code: ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS,
      message: `Cannot modify an approval in status "${existing.status}"`,
    });
  }

  const [row] = await db
    .update(toolApprovalRequests)
    .set({
      status: "granted",
      operations: params.operations,
      itemCount: params.operations.length,
      summary: params.summary,
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
    return throwHttpError(409, {
      code: ERROR_CODES.TOOL_APPROVAL_WRONG_STATUS,
      message: "Approval status changed concurrently",
    });
  }
  return row;
};
