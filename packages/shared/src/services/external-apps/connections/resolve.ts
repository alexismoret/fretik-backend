import db from "../../../db";
import { type ExternalAppConnection } from "../../../db/schema";
import { throwHttpError } from "../../../lib/errors";
import { ERROR_CODES } from "../../../schemas/errors";
import { reachesTeamSharedConnections } from "./team-shared-reach";

/**
 * Resolve the connection an op should run against.
 *
 *  - If `explicitId` is given (the agent passed `connection_id: <id>` in
 *    the op's args — typical when the user has both a "Pro" and a
 *    "Personal" connection), find that row scoped to the caller
 *    (team-shared or user-scoped to them) and return it.
 *  - Otherwise filter by provider + caller's scope. Exactly one active
 *    connection → return it. Zero → `EXTERNAL_APP_NO_CONNECTION`. Two or
 *    more → `EXTERNAL_APP_AMBIGUOUS_CONNECTION` so the dispatcher can
 *    surface the choices to the agent. The agent then either retries
 *    with `connection_id` or asks the user.
 *
 * Disabled and errored connections are filtered out — the dispatcher
 * treats them as if they didn't exist for the purpose of selection.
 *
 * The team's shared connections are for its own people only
 * (`reachesTeamSharedConnections`): someone who takes part in one of its
 * projects from another team resolves their own, or nothing.
 */
export const resolveConnection = async (params: {
  providerKey: string;
  teamId: string;
  userId: string;
  explicitId?: string;
}): Promise<ExternalAppConnection> => {
  const callerScope = (await reachesTeamSharedConnections(
    params.teamId,
    params.userId,
  ))
    ? { OR: [{ userId: { isNull: true as const } }, { userId: params.userId }] }
    : { userId: params.userId };

  if (params.explicitId !== undefined && params.explicitId !== "") {
    const row = await db.query.externalAppConnections.findFirst({
      where: {
        id: params.explicitId,
        teamId: params.teamId,
        ...callerScope,
      },
    });
    if (row === undefined) {
      return throwHttpError(404, {
        code: ERROR_CODES.EXTERNAL_APP_CONNECTION_NOT_FOUND,
        message: `Connection ${params.explicitId} not found`,
      });
    }
    return row;
  }

  const candidates = await db.query.externalAppConnections.findMany({
    where: {
      providerKey: params.providerKey,
      teamId: params.teamId,
      status: "active",
      ...callerScope,
    },
  });

  const [first, second] = candidates;
  if (first === undefined) {
    return throwHttpError(404, {
      code: ERROR_CODES.EXTERNAL_APP_NO_CONNECTION,
      message: `No active connection for provider ${params.providerKey}`,
    });
  }
  if (second !== undefined) {
    // Surface the choice list so the agent can pass `connection_id` on retry.
    const choices = candidates
      .map((c) => `${c.id}:${c.displayName}`)
      .join(", ");
    return throwHttpError(409, {
      code: ERROR_CODES.EXTERNAL_APP_AMBIGUOUS_CONNECTION,
      message: `Multiple connections for provider ${params.providerKey} — pass connection_id`,
      details: choices,
    });
  }
  return first;
};
