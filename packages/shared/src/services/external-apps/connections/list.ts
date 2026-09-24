import db from "../../../db";
import { type ExternalAppConnection } from "../../../db/schema";
import { reachesTeamSharedConnections } from "./team-shared-reach";

/**
 * Connections visible to `userId` in `teamId`:
 *  - every team-scoped connection (`user_id IS NULL`), for the team's own
 *    people (`reachesTeamSharedConnections`),
 *  - plus connections the caller scoped to themselves.
 *
 * Returned newest-first. Used by `/settings/external-apps` and by the
 * chatbot handler to feed the agent's runtime context.
 */
export const listConnections = async (
  teamId: string,
  userId: string,
): Promise<ExternalAppConnection[]> => {
  const teamShared = await reachesTeamSharedConnections(teamId, userId);
  return db.query.externalAppConnections.findMany({
    where: {
      teamId,
      ...(teamShared
        ? { OR: [{ userId: { isNull: true } }, { userId }] }
        : { userId }),
    },
    orderBy: { createdAt: "desc" },
  });
};
