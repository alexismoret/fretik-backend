import db from "../../db";
import { badRequest, throwHttpError } from "../../lib/errors";

/**
 * Vet the external-app connections a workflow declares, against the workflow's
 * own scope.
 *
 * The rule is not a policy we invented — it is what the runtime already does.
 * A run acts as `workflow.userId ?? the team bot`, and a connection is
 * resolvable only when it is team-shared or scoped to that very identity. So a
 * TEAM workflow (no owner, runs as the bot) can never reach a personal
 * connection: declaring one would promise an app the run cannot open, and the
 * failure would surface much later as `EXTERNAL_APP_NO_CONNECTION` inside a
 * cron run nobody is watching. Refusing at write turns that into a sentence
 * the author reads while they still have the context to act on it.
 *
 * A PRIVATE workflow runs as its owner, so it may declare team connections AND
 * that owner's own personal ones — never a third party's, which the visibility
 * `where` below already makes unreachable.
 *
 * Returns the ids, de-duplicated and in the order given. An empty list means
 * "nothing declared" and is always valid.
 */
export const validateWorkflowExternalApps = async (params: {
  connectionIds: string[];
  teamId: string;
  /** The workflow's owner: null = team-shared (runs as the team bot). */
  ownerUserId: string | null;
}): Promise<string[]> => {
  const ids = [...new Set(params.connectionIds)];
  if (ids.length === 0) return ids;

  const rows = await db.query.externalAppConnections.findMany({
    columns: { id: true, userId: true, displayName: true },
    where: {
      id: { in: ids },
      teamId: params.teamId,
      // Same predicate as `getConnectionForCaller`, with the WORKFLOW's
      // identity in place of the caller's: someone else's personal connection
      // must not even be nameable here.
      OR: [
        { userId: { isNull: true } },
        ...(params.ownerUserId !== null
          ? [{ userId: params.ownerUserId }]
          : []),
      ],
    },
  });

  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return throwHttpError(
      400,
      badRequest(
        `Unknown external-app connection(s) for this workflow: ${missing.join(", ")}. A team workflow can only use connections shared with the team; a private one, those plus its owner's own.`,
      ),
    );
  }

  if (params.ownerUserId === null) {
    const personal = rows.filter((row) => row.userId !== null);
    if (personal.length > 0) {
      return throwHttpError(
        400,
        badRequest(
          `A team workflow runs as the team assistant and cannot use a personal connection (${personal.map((row) => row.displayName).join(", ")}). Make the workflow private, or share the connection with the team.`,
        ),
      );
    }
  }

  return ids;
};
