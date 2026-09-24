import db from "../../../db";
import { type ExternalAppConnection } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { reachesTeamSharedConnections } from "./team-shared-reach";

/**
 * Fetch a connection by ID and check the caller may see it: same team
 * AND either team-scoped (`user_id IS NULL`, for the team's own people) or
 * scoped to the caller. 404 otherwise — never leak the existence of another
 * team's row.
 */
export const getConnectionForCaller = async (
  id: string,
  teamId: string,
  userId: string,
): Promise<ExternalAppConnection> => {
  const teamShared = await reachesTeamSharedConnections(teamId, userId);
  const row = await db.query.externalAppConnections.findFirst({
    where: {
      id,
      teamId,
      ...(teamShared
        ? { OR: [{ userId: { isNull: true } }, { userId }] }
        : { userId }),
    },
  });
  if (row === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_CONNECTION_NOT_FOUND,
      message: "Connection not found",
    });
  }
  return row;
};
