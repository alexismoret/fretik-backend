import { eq } from "drizzle-orm";
import db from "../../../db";
import {
  type ExternalAppConnection,
  type ExternalAppConnectionStatus,
  externalAppConnections,
} from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { getConnectionForCaller } from "./get-by-id";

/**
 * Rename a connection or flip its status (`active` ↔ `disabled`). Only
 * the original creator or members with team-wide access can update —
 * `getConnectionForCaller` already enforces team+user-scope visibility,
 * so anyone who can see the connection can update it.
 *
 * Status `error` is set by the dispatcher itself on a Nango 401/403, not
 * by users — it's accepted here for completeness (admins flipping back
 * to `active` after a manual recovery).
 */
export const updateConnection = async (params: {
  id: string;
  teamId: string;
  userId: string;
  displayName?: string;
  status?: ExternalAppConnectionStatus;
}): Promise<ExternalAppConnection> => {
  await getConnectionForCaller(params.id, params.teamId, params.userId);

  const patch: Partial<ExternalAppConnection> = { updatedAt: new Date() };
  if (params.displayName !== undefined) patch.displayName = params.displayName;
  if (params.status !== undefined) {
    patch.status = params.status;
    if (params.status !== "error") patch.lastErrorMessage = null;
  }

  const [row] = await db
    .update(externalAppConnections)
    .set(patch)
    .where(eq(externalAppConnections.id, params.id))
    .returning();

  if (row === undefined) {
    return throwHttpError(500, {
      code: ERROR_CODES.DATABASE_ERROR,
      message: "Failed to update connection",
    });
  }
  return row;
};
