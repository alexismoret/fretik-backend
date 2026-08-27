import type { ExternalAppConnection } from "../../../db/schema";
import { deleteKeysByPrefix, redis } from "../../../lib/redis";

/**
 * A counter that retires cached page data the moment the CONNECTIONS behind it
 * change.
 *
 * The page-data cache deliberately has no event-driven invalidation: watching
 * every record write would reach the whole codebase to buy 20 seconds
 * (`services/pages/data-cache.ts`). Connections are the one exception, and the
 * reason is what the delay MEANS. A stale number is a number; a stale
 * `needs_connection` is a wall — the viewer connects the app, comes back, and
 * the page still tells them to connect it. That reads as "connecting did not
 * work", and it is the state a user reported being stuck in.
 *
 * Two counters, not one, so a personal connection does not evict the whole
 * team's cached pages:
 *   - `ext:epoch:{teamId}`          — team-scoped changes, everyone's answers;
 *   - `ext:epoch:{teamId}:{userId}` — one member's own connections.
 * Both ride in the cache key, so a bump on either side retires exactly the
 * entries that could have resolved differently.
 *
 * Counters rather than key scanning: `INCR` is O(1) and correct across
 * replicas, where `deleteKeysByPrefix("page:data:")` is a SCAN over a keyspace
 * shared with chat and session data.
 */

/**
 * Sliding, and it must stay ENORMOUS next to `PAGE_DATA_CACHE_TTL` (20 s).
 *
 * A counter that outlives every entry it stamped can be forgotten safely: when
 * it expires the numbering restarts at 0, and the only way that serves stale
 * data is if an entry stamped with the OLD 0 were still alive — 7 days after it
 * was written, with a 20 s TTL. So the horizon buys a bounded keyspace (one
 * pair per team and per member who ever connected an app, dropped once they go
 * quiet) at no correctness cost. Shrinking it toward the data TTL is what would
 * make the reuse real.
 */
const EPOCH_TTL_SECONDS = 7 * 24 * 60 * 60;

const teamKey = (teamId: string): string => `ext:epoch:${teamId}`;
const userKey = (teamId: string, userId: string): string =>
  `ext:epoch:${teamId}:${userId}`;

/** The pair, as one string, for the page-data cache key. */
export const externalConnectionsEpoch = async (params: {
  teamId: string;
  /** The viewer; null on the anonymous route, which sees the team tier only. */
  userId: string | null;
}): Promise<string> => {
  const keys =
    params.userId === null
      ? [teamKey(params.teamId)]
      : [teamKey(params.teamId), userKey(params.teamId, params.userId)];
  try {
    const values = await redis.mget(...keys);
    return values.map((value) => value ?? "0").join(".");
  } catch (error) {
    // A cache key is not worth failing a page render for. Falling back to a
    // constant only costs the epoch's contribution: the key still carries the
    // team, the viewer and the definition's fingerprint.
    console.warn(
      "[external-apps] could not read the connections epoch:",
      error instanceof Error ? error.message : error,
    );
    return "0";
  }
};

/**
 * Move the epoch a connection change belongs to. `userId` set means the change
 * was to that member's OWN connection and nobody else's answers can differ;
 * omit it for a team-scoped connection.
 *
 * Never throws: this runs after the write it follows, and a Redis hiccup must
 * cost at most 20 seconds of staleness, never the connection the user just
 * made.
 */
export const bumpExternalConnectionsEpoch = async (params: {
  teamId: string;
  userId?: string | null;
}): Promise<void> => {
  const key =
    params.userId === undefined || params.userId === null
      ? teamKey(params.teamId)
      : userKey(params.teamId, params.userId);
  try {
    // One round trip, and the EXPIRE rides along on every bump so an active
    // team keeps its counter while a dormant one lets it go.
    await redis.multi().incr(key).expire(key, EPOCH_TTL_SECONDS).exec();
  } catch (error) {
    console.warn(
      "[external-apps] could not bump the connections epoch — page data may stay stale for its TTL:",
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * Drop the upstream answers cached against ONE connection.
 *
 * The epoch does not cover these: `page:ext:v1:{connectionId}:…` is keyed by
 * connection id, so a NEW connection is already a new key and needs nothing.
 * What needs this is a connection whose id survives while what it answers
 * changes — reconnected with different credentials, or deleted while its
 * answers are still warm.
 */
const purgeConnectionAnswerCache = async (
  connectionId: string,
): Promise<void> => {
  try {
    await deleteKeysByPrefix(`page:ext:v1:${connectionId}:`);
  } catch (error) {
    console.warn(
      "[external-apps] could not purge cached answers for connection",
      connectionId,
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * The one call every connection write makes on its way out — so that "I
 * connected it and the page still says to connect it" cannot come back through
 * a path somebody forgot.
 *
 * `purgeAnswers` is for a change that keeps the connection's ID while altering
 * what it answers, or whether it may answer at all: reconnected credentials, a
 * disable, a deletion. Creating a connection needs none of it — a new id is a
 * new cache key already.
 */
export const invalidateConnectionCaches = async (params: {
  connection: Pick<ExternalAppConnection, "id" | "teamId" | "userId">;
  purgeAnswers?: boolean;
}): Promise<void> => {
  await bumpExternalConnectionsEpoch({
    teamId: params.connection.teamId,
    userId: params.connection.userId,
  });
  if (params.purgeAnswers === true) {
    await purgeConnectionAnswerCache(params.connection.id);
  }
};
