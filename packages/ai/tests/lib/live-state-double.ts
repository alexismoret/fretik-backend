/**
 * In-memory stand-in for the live-state SNAPSHOT readers
 * (`@fretik/shared/services/model-registry/live`), registered globally from
 * `tests/preload.ts` for the same reason the team-settings double is: the
 * module is reached from `model-registry/resolve.ts`, which half the unit
 * suite imports transitively, so whichever test file loads that chain first
 * would permanently bind the real reference and a later per-file
 * `mock.module()` would win or lose depending on execution order.
 *
 * It defaults to an EMPTY snapshot, which is byte-for-byte what the real
 * module answers on a cold process — so registering it changes nothing for
 * every test that does not call `setLiveStateDouble`.
 *
 * Only the two synchronous readers are replaced. The subscription and the
 * async loaders stay real: they are already inert under the preloaded Redis
 * and database doubles, and replacing them would mean re-implementing the
 * invalidation path rather than exercising it.
 */
import type { LiveModelState } from "@fretik/shared/model-registry/types";

let rows = new Map<string, LiveModelState>();

export const getLiveStateSync = (
  profileKey: string,
): LiveModelState | undefined => rows.get(profileKey);

export const getLiveSnapshotSync = ():
  ReadonlyMap<string, LiveModelState> | undefined =>
  rows.size === 0 ? undefined : rows;

/** Replace the snapshot. Pass nothing to go back to cold. */
export const setLiveStateDouble = (
  next: readonly LiveModelState[] = [],
): void => {
  rows = new Map(next.map((row) => [row.profileKey, row]));
};
