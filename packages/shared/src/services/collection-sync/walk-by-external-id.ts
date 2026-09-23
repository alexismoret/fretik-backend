import type { CollectionSyncSource } from "../../db/schema";
import type { syncActor } from "./agent-key";
import { applyOrphanPolicy } from "./apply-orphans";
import {
  countNewOrphans,
  hitsOrphanFloor,
  listOrphanIds,
  orphanFloorReason,
} from "./orphan-bracket";
import { readPath } from "./project-row";
import { loadTableSyncIndexFor } from "./record-state";
import {
  runWalkSync,
  type RunWalkSyncInput,
  type WalkResolverFactory,
  type WalkSyncOutcome,
} from "./run-walk-sync";

/**
 * The `table` resolver: the app's list IS the collection.
 *
 * A row is keyed by its own upstream id, a key nobody here has seen becomes a
 * record, and a record this walk did not see is an ORPHAN — which is the one
 * place a sync can destroy something, and therefore the one place with a floor
 * and a confirmation in front of it.
 */

/** Orphan ids taken per page when the policy is applied. */
const ORPHAN_PAGE = 2_000;

export const byExternalId: WalkResolverFactory = ({ source, actor }) => {
  const externalIdPath = source.externalIdPath;
  if (externalIdPath === null || externalIdPath === "") {
    // The create schema refuses this, so reaching it means a row was written
    // around the service. Failing loudly beats duplicating the collection.
    throw new Error(
      "this table source has no externalIdPath: without a stable upstream id, every run would duplicate the collection",
    );
  }

  return {
    keyOf: (row) => {
      const raw = readPath(row, externalIdPath);
      if (typeof raw === "string") return raw;
      // A number is accepted and stringified because plenty of APIs send an
      // integer id in JSON; anything else (an object, a null, a boolean)
      // cannot survive a round trip as an identifier.
      return typeof raw === "number" && Number.isFinite(raw)
        ? String(raw)
        : undefined;
    },
    resolve: async (keys) => {
      const index = await loadTableSyncIndexFor(source.id, keys);
      // One record per upstream id, guaranteed by
      // `collection_records_sync_external_uniq` — so the list this resolver
      // must return is always of length one.
      return new Map([...index].map(([key, entry]) => [key, [entry]]));
    },
    unknownRows: "create",
    afterFullWalk: async ({ walkStartedAt, ignoreOrphanFloor, counts }) => {
      const census = await countNewOrphans({
        syncSourceId: source.id,
        walkStartedAt,
      });
      if (!ignoreOrphanFloor && hitsOrphanFloor(census)) {
        return { kind: "floor", reason: orphanFloorReason(census) };
      }
      counts.orphanCount = await applyOrphans({
        source,
        walkStartedAt,
        actor,
      });
      return { kind: "applied" };
    },
  };
};

export const runTableWalk = async (
  input: Omit<RunWalkSyncInput, "resolver">,
): Promise<WalkSyncOutcome> =>
  await runWalkSync({ ...input, resolver: byExternalId });

/** Apply the policy to every orphan, a page of ids at a time. */
const applyOrphans = async (ctx: {
  source: CollectionSyncSource;
  walkStartedAt: Date;
  actor: ReturnType<typeof syncActor>;
}): Promise<number> => {
  let applied = 0;
  let after: string | null = null;
  for (;;) {
    const ids: string[] = await listOrphanIds({
      syncSourceId: ctx.source.id,
      walkStartedAt: ctx.walkStartedAt,
      after,
      limit: ORPHAN_PAGE,
    });
    if (ids.length === 0) return applied;
    applied += await applyOrphanPolicy({
      organizationId: ctx.source.organizationId,
      teamId: ctx.source.teamId,
      syncSourceId: ctx.source.id,
      policy: ctx.source.orphanPolicy,
      recordIds: ids,
      actor: ctx.actor,
    });
    // `keep` and `reject` leave the row in place with `status = 'missing'`, so
    // the query that found it no longer will — but `delete` removes it and
    // `keep` on a row that was already `missing` is a no-op. The cursor is what
    // makes all three terminate: it only ever moves forward.
    after = ids[ids.length - 1] ?? null;
    if (ids.length < ORPHAN_PAGE) return applied;
  }
};
