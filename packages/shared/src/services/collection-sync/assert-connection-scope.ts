import db from "../../db";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";

/**
 * A sync source may only be built on a connection its creator may use.
 *
 * Anyone on the team can create a source — the same bar as creating a
 * collection — and the one thing that bar does NOT relax is whose credentials
 * the source runs on. A connection with a `user_id` is personal: it holds one
 * person's token, and a scheduled source built on it would keep calling a
 * third party as that person, every fifteen minutes, for as long as the source
 * lives, on behalf of a team they did not agree to lend it to. A team
 * connection is the shared one and is what a source is for.
 *
 * Enforced in the service and not at the route, because two callers reach
 * creation — the HTTP API and the agent's tool — and a check on one door is a
 * check on neither.
 */
export const assertConnectionUsable = async (input: {
  connectionId: string;
  teamId: string;
  /** The person acting. `null` = a background caller, which has no personal
   * connection of its own and may therefore only use a team one. */
  userId: string | null;
}): Promise<{ providerKey: string }> => {
  const connection = await db.query.externalAppConnections.findFirst({
    where: { id: input.connectionId, teamId: input.teamId },
    columns: {
      id: true,
      userId: true,
      displayName: true,
      status: true,
      providerKey: true,
    },
  });
  if (connection === undefined) {
    return throwHttpError(404, notFound("Connection"));
  }
  if (connection.userId !== null && connection.userId !== input.userId) {
    return throwHttpError(
      400,
      badRequest(
        `"${connection.displayName}" is a personal connection and only its owner can build a sync on it. Ask them to create the source, or connect the app for the whole team.`,
      ),
    );
  }
  if (connection.status !== "active") {
    return throwHttpError(
      400,
      badRequest(
        `"${connection.displayName}" is ${connection.status} — reconnect it under Settings → Connected apps, then create the source.`,
      ),
    );
  }
  // Handed back so the source is stamped with the connection's OWN provider
  // rather than one the caller stated separately. The two disagreeing means a
  // source that resolves its action against the wrong app's manifest, which
  // fails at the first run and is unobvious in the row.
  return { providerKey: connection.providerKey };
};
