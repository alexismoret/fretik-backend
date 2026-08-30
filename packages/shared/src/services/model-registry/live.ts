import { eq } from "drizzle-orm";
import db from "../../db";
import {
  type ModelLiveStateRow,
  modelLiveState,
} from "../../db/schema/model-registry";
import { redis } from "../../lib/redis";
import { subscribeChannel } from "../../lib/redis-subscriber";
import type { LiveModelState } from "../../model-registry/types";

/**
 * The read path for live model state.
 *
 * Deliberately WITHOUT a Redis snapshot layer. The table holds a few dozen
 * small rows, so the database read costs less than the serialisation would, and
 * a cached snapshot brings a failure mode this codebase has already paid for:
 * a shape change that a running deploy keeps serving from an old key until
 * someone remembers to bump it by hand. What we do need is speed on the hot
 * path and immediacy after a write — an in-process cache gives the first, a
 * pub/sub invalidation gives the second.
 *
 * Degradation is total and silent by design: a database or Redis failure leaves
 * callers with the last snapshot, or with nothing, and "nothing" means the
 * TypeScript registry's own defaults take over in `@fretik/ai`. Model
 * resolution must never fail because a metadata table is unreachable.
 */

const INVALIDATE_CHANNEL = "model-live:invalidate";

/**
 * How long a snapshot is trusted without re-reading. Short enough that a missed
 * invalidation message self-heals within a minute, long enough that a busy
 * process is not re-reading the table per turn.
 */
const SNAPSHOT_TTL_MS = 60_000;

/** A read that hangs must not hang a turn. */
const READ_TIMEOUT_MS = 3_000;

type Snapshot = { byKey: Map<string, LiveModelState>; fetchedAt: number };

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let subscribed = false;
const changeListeners = new Set<() => void>();

const toLiveState = (row: ModelLiveStateRow): LiveModelState => ({
  profileKey: row.profileKey,
  status: row.status,
  transport: row.transport,
  enabled: row.enabled,
  disabledReason: row.disabledReason ?? null,
  modelIds: row.modelIds,
  providerPool: row.providerPool,
  quarantinedProviders: row.quarantinedProviders,
  poolWidened: row.poolWidened,
  lastResort: row.lastResort,
  effectiveContextLength: row.effectiveContextLength,
  effectiveMaxOutput: row.effectiveMaxOutput,
  pricing: row.pricing,
  creditMultiplier: row.creditMultiplier,
  health: row.health,
  healthScore: row.healthScore,
  policyReport: row.policyReport,
  endpointStats: row.endpointStats ?? [],
  aaMetrics: row.aaMetrics,
  releasedAt: row.releasedAt ?? null,
  aaSlug: row.aaSlug ?? null,
  dynamicProfile: row.dynamicProfile,
  boundRoles: row.boundRoles,
  source: row.source,
  syncedAt: row.syncedAt,
});

/**
 * Subscribe once per process. Registration is lazy — never at module load — so
 * importing this file in a unit test with no Redis costs nothing.
 */
const ensureSubscribed = (): void => {
  if (subscribed) return;
  subscribed = true;
  try {
    subscribeChannel(INVALIDATE_CHANNEL, () => {
      // Same rule as the local path: expire and reload, never empty. A replica
      // that answered `undefined` for every model on hearing about someone
      // else's write would be the widest form of the bug, since one write
      // would blank the whole fleet at once.
      expireAndReload();
      for (const listener of [...changeListeners]) {
        try {
          listener();
        } catch (err: unknown) {
          console.error(
            "[model-live] change listener threw:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    });
  } catch (err: unknown) {
    // A replica with no Redis still serves; it just refreshes on the TTL
    // instead of instantly.
    subscribed = false;
    console.warn(
      "[model-live] could not subscribe to invalidations:",
      err instanceof Error ? err.message : err,
    );
  }
};

const readFromDb = async (): Promise<Snapshot> => {
  const rows = await db.select().from(modelLiveState);
  return {
    byKey: new Map(rows.map((row) => [row.profileKey, toLiveState(row)])),
    fetchedAt: Date.now(),
  };
};

const refresh = async (): Promise<Snapshot> => {
  inflight ??= (async (): Promise<Snapshot> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn("[model-live] database read timed out — serving stale");
          resolve(null);
        }, READ_TIMEOUT_MS);
      });
      const result = await Promise.race([readFromDb(), timeout]);
      if (result === null)
        return snapshot ?? { byKey: new Map(), fetchedAt: 0 };
      snapshot = result;
      return result;
    } catch (err: unknown) {
      console.error(
        "[model-live] database read failed — falling back to code defaults:",
        err instanceof Error ? err.message : err,
      );
      // fetchedAt 0 so the next call retries rather than trusting the empty map.
      return snapshot ?? { byKey: new Map(), fetchedAt: 0 };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
};

/**
 * Every model's live state, keyed by profile key. Warm this once at boot so the
 * synchronous accessors below have something to read.
 */
export const getLiveRegistry = async (): Promise<
  ReadonlyMap<string, LiveModelState>
> => {
  ensureSubscribed();
  const current = snapshot;
  if (current && Date.now() - current.fetchedAt < SNAPSHOT_TTL_MS)
    return current.byKey;
  const fresh = await refresh();
  return fresh.byKey;
};

/**
 * One model's live state from the in-process snapshot, or `undefined` when the
 * snapshot is cold or the model has no row. Synchronous on purpose: model
 * construction is synchronous, and making it async would turn every resolution
 * site into a promise for a value that is nearly always already in memory.
 * `undefined` is a normal answer — the caller falls back to its own defaults.
 */
export const getLiveStateSync = (
  profileKey: string,
): LiveModelState | undefined => snapshot?.byKey.get(profileKey);

/** The whole in-process snapshot, or `undefined` when cold. */
export const getLiveSnapshotSync = ():
  ReadonlyMap<string, LiveModelState> | undefined => snapshot?.byKey;

/**
 * Run `listener` whenever live state changes anywhere in the fleet. Used to
 * drop memoized model instances: a pool or transport change has to take effect
 * on the next call, not on the next deploy.
 */
export const onLiveRegistryChange = (listener: () => void): (() => void) => {
  ensureSubscribed();
  changeListeners.add(listener);
  return (): void => {
    changeListeners.delete(listener);
  };
};

/**
 * Expire the snapshot WITHOUT emptying it, and start reloading.
 *
 * Dropping it to `null` was a hole, not a cache miss. `getLiveStateSync` is
 * synchronous by design — model construction cannot await — so it cannot
 * reload; it can only report what is in memory. With `null` in memory it
 * answers `undefined` for EVERY model, and `undefined` is a legitimate answer
 * meaning "no live row, use code defaults". So the moment any replica wrote a
 * quarantine, every model built anywhere in the fleet lost its pool, its
 * transport and its usable context until an unrelated `await` happened to
 * reload — and the invalidation also clears the resolved-model memo, which
 * guarantees those rebuilds happen immediately. The write meant to enforce a
 * quarantine was instead erasing every quarantine.
 *
 * Keeping the previous snapshot and marking it expired serves state that is at
 * most one write behind, while the reload started here replaces it within
 * milliseconds. One-write-stale is a small, bounded error; a hole is not.
 */
const expireAndReload = (): void => {
  if (snapshot !== null) snapshot = { ...snapshot, fetchedAt: 0 };
  // Deliberately not awaited: callers are finishing a write, and the reload
  // must not make that write's latency depend on a second database round trip.
  void refresh();
};

/**
 * Announce that live state changed. Expires this process's snapshot and tells
 * every other replica to do the same. Never throws: a failed publish costs at
 * most `SNAPSHOT_TTL_MS` of staleness elsewhere, which is not worth failing a
 * write that already landed.
 */
export const invalidateLiveRegistry = async (): Promise<void> => {
  expireAndReload();
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch {
      // Listener errors are already logged in the subscriber path.
    }
  }
  try {
    await redis.publish(INVALIDATE_CHANNEL, Date.now().toString());
  } catch (err: unknown) {
    console.warn(
      "[model-live] invalidation publish failed — replicas refresh on TTL:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** Read one row straight from the database, bypassing every cache. */
export const readLiveStateRow = async (
  profileKey: string,
): Promise<LiveModelState | undefined> => {
  const [row] = await db
    .select()
    .from(modelLiveState)
    .where(eq(modelLiveState.profileKey, profileKey))
    .limit(1);
  return row ? toLiveState(row) : undefined;
};

/** Every row, straight from the database. For the sync and the admin CLI. */
export const readAllLiveStateRows = async (): Promise<LiveModelState[]> => {
  const rows = await db.select().from(modelLiveState);
  return rows.map(toLiveState);
};

/** Reset the in-process snapshot. Tests only. */
export const resetLiveRegistryCache = (): void => {
  snapshot = null;
  inflight = null;
};
