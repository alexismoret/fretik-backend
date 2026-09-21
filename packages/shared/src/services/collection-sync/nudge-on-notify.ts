import { and, inArray, isNull, sql } from "drizzle-orm";
import db from "../../db";
import { collectionSyncSources } from "../../db/schema";
import { redis } from "../../lib/redis";
import type { SyncArgs } from "../../schemas/collection-sync";
import { SYNC_LIMITS, syncArgsBindSince } from "../../schemas/collection-sync";

/**
 * "The app says something changed" — bring its incremental sources forward.
 *
 * This is the whole of what a webhook buys us, and the restraint is the point.
 * A notification does NOT say what changed (see `decide-nango-webhook.ts` on
 * why the payload is never read); it says the app is not idle. So the only
 * thing it may do is move `next_run_at` to now on sources that were already
 * going to run anyway. The run that follows is an ordinary one and decides for
 * itself what to fetch.
 *
 * Polling stays. A webhook is an accelerator, never the mechanism: a provider
 * that stops delivering, an integration whose webhook URL was never registered
 * with the provider (an operator step — `OPERATIONS.md`), or a delivery lost in
 * transit must all cost freshness and never correctness. Make the schedule
 * depend on the webhook and every one of those becomes a collection that
 * silently stopped updating.
 */

/**
 * How long one connection is left alone after a nudge.
 *
 * Equal to the interval floor a source may be configured with, and for the same
 * reason: an app that fires a webhook per changed record would otherwise turn
 * one busy minute into one run per record, past every cadence the team chose.
 * The debounce is per CONNECTION rather than per source, because the burst is a
 * property of the app, not of what we point at it.
 *
 * Cluster-wide, because replicas receive the deliveries independently — a
 * per-process guard would let N replicas nudge N times for one event.
 */
const NUDGE_DEBOUNCE_SECONDS = SYNC_LIMITS.minIntervalMinutes * 60;

const nudgeKey = (connectionId: string): string => `sync:nudge:${connectionId}`;

export type NudgeOutcome =
  | { nudged: true; sourceIds: string[] }
  | {
      nudged: false;
      reason:
        | "unknown_connection"
        | "connection_disabled"
        | "debounced"
        | "no_sources";
    };

export const nudgeSyncSourcesForConnection = async (params: {
  nangoConnectionId: string;
  nangoProviderConfigKey: string;
}): Promise<NudgeOutcome> => {
  const connection = await db.query.externalAppConnections.findFirst({
    where: {
      nangoConnectionId: params.nangoConnectionId,
      nangoProviderConfigKey: params.nangoProviderConfigKey,
    },
    columns: { id: true, status: true },
  });
  // A delivery for a connection we do not hold is ordinary: the same Nango
  // environment serves other things, and a connection deleted here still has
  // its webhook registered with the provider for a while.
  if (connection === undefined) {
    return { nudged: false, reason: "unknown_connection" };
  }
  // A team that disabled a connection said they do not want it acting. The
  // scheduled sweep already skips its sources; an app the team parked must not
  // be able to wake them from the outside.
  if (connection.status === "disabled") {
    return { nudged: false, reason: "connection_disabled" };
  }

  const claimed = await redis.set(
    nudgeKey(connection.id),
    "1",
    "EX",
    NUDGE_DEBOUNCE_SECONDS,
    "NX",
  );
  if (claimed === null) return { nudged: false, reason: "debounced" };

  // `next_run_at > now()` is the load-bearing half: a source already due, or
  // already claimed by a runner, needs nothing from us — and overwriting
  // `next_run_at` under a running source would be undone by `scheduleNextRun`
  // the moment that run ends, exactly as `request-refresh.ts` documents.
  //
  // `next_run_at IS NOT NULL` excludes the manual ones. "Only when I ask" means
  // the TEAM, not the app: a manual source that an app's webhook could start is
  // not manual, and nobody would be watching for the run it produced.
  const candidates = await db.execute<{ id: string; args: SyncArgs }>(sql`
    SELECT id, args
      FROM collection_sync_sources
     WHERE connection_id = ${connection.id}::uuid
       AND enabled
       AND claimed_at IS NULL
       AND next_run_at IS NOT NULL
       AND next_run_at > now()`);

  // Incremental only, and this is the rule that keeps a webhook cheap. A
  // notification says "ask for the delta", never "walk a hundred pages again":
  // a full source brought forward by every notification costs its whole page
  // budget per burst, which is the opposite of what the webhook was for.
  //
  // Filtered in TS rather than SQL because the binding can sit at any depth in
  // the args (`syncArgsBindSince` walks it), and a `LIKE` over jsonb text would
  // match a literal string containing `$since` just as happily.
  const sourceIds = candidates.rows
    .filter((row) => syncArgsBindSince(row.args))
    .map((row) => row.id);
  if (sourceIds.length === 0) return { nudged: false, reason: "no_sources" };

  // Re-checking `claimed_at` is not redundant with the SELECT above: a sweep
  // can claim a source between the two statements, and the update would then
  // move `next_run_at` under a run in flight.
  await db
    .update(collectionSyncSources)
    .set({ nextRunAt: new Date() })
    .where(
      and(
        inArray(collectionSyncSources.id, sourceIds),
        isNull(collectionSyncSources.claimedAt),
      ),
    );

  return { nudged: true, sourceIds };
};
