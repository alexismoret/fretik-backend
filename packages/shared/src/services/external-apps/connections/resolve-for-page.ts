import db from "../../../db";
import { type ExternalAppConnection } from "../../../db/schema";

/**
 * Resolve the connection a PAGE dataset or operation runs against — the page
 * sibling of `resolveConnection`, different on purpose in three ways:
 *
 * 1. It never throws HTTP errors. A page degrades per dataset, so every
 *    outcome is a value the caller renders — including "this viewer just has
 *    to connect their account", which is a prompt, not a failure.
 * 2. It PREFERS the viewer's own connection over the team's shared one when
 *    the dataset names a provider (`resolveConnection` treats the two tiers as
 *    one pool and calls two candidates ambiguous). Same page, each member's
 *    own data — the whole point of resolving at view time.
 * 3. A PINNED connection that is user-scoped to someone else resolves to
 *    `needs_connection`, never to that person's account: a shared page must
 *    not spend a colleague's credentials on another viewer's screen.
 */
export type PageConnectionResolution =
  | { status: "ok"; connection: ExternalAppConnection }
  | { status: "needs_connection"; providerKey: string; displayName?: string }
  | { status: "error"; message: string };

export const resolvePageConnection = async (params: {
  teamId: string;
  /** The viewer; null on the anonymous route (only a team pin could pass). */
  userId: string | null;
  connectionId?: string;
  providerKey?: string;
}): Promise<PageConnectionResolution> => {
  if (params.connectionId !== undefined) {
    const row = await db.query.externalAppConnections.findFirst({
      where: { id: params.connectionId, teamId: params.teamId },
    });
    if (row === undefined) {
      return {
        status: "error",
        message: "the pinned connection no longer exists on this team",
      };
    }
    if (row.userId !== null && row.userId !== params.userId) {
      // Someone else's personal connection — the viewer needs their own.
      return {
        status: "needs_connection",
        providerKey: row.providerKey,
        displayName: row.displayName,
      };
    }
    if (row.status !== "active") {
      return {
        status: "error",
        message: `connection "${row.displayName}" is ${row.status} — fix it under Settings → Connected apps`,
      };
    }
    return { status: "ok", connection: row };
  }

  if (params.providerKey === undefined) {
    return {
      status: "error",
      message: "a connection needs providerKey or a pinned connectionId",
    };
  }

  const candidates = await db.query.externalAppConnections.findMany({
    where: {
      providerKey: params.providerKey,
      teamId: params.teamId,
      status: "active",
      // No viewer (anonymous) → only the team tier may match; an empty-string
      // uuid comparison would not "not match", it would fail the query.
      ...(params.userId === null
        ? { userId: { isNull: true } }
        : { OR: [{ userId: { isNull: true } }, { userId: params.userId }] }),
    },
  });

  const personal = candidates.filter(
    (row) => row.userId !== null && row.userId === params.userId,
  );
  const shared = candidates.filter((row) => row.userId === null);
  const tier = personal.length > 0 ? personal : shared;

  const [first, second] = tier;
  if (first === undefined) {
    return { status: "needs_connection", providerKey: params.providerKey };
  }
  if (second !== undefined) {
    const choices = tier
      .map((row) => `${row.id}:${row.displayName}`)
      .join(", ");
    return {
      status: "error",
      message: `several ${params.providerKey} connections match (${choices}) — pin one with connectionId`,
    };
  }
  return { status: "ok", connection: first };
};
