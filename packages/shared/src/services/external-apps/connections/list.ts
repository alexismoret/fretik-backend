import db from "../../../db";
import { type ExternalAppConnection } from "../../../db/schema";

/**
 * Connections visible to a member of `teamId` acting as `userId`:
 *  - every team-scoped connection (`user_id IS NULL`),
 *  - plus connections the caller scoped to themselves.
 *
 * Returned newest-first. Used by `/settings/external-apps` and by the
 * chatbot handler to feed the agent's runtime context.
 */
export const listConnections = async (
  teamId: string,
  userId: string,
): Promise<ExternalAppConnection[]> =>
  db.query.externalAppConnections.findMany({
    where: {
      teamId,
      OR: [{ userId: { isNull: true } }, { userId }],
    },
    orderBy: { createdAt: "desc" },
  });
