import { eq, inArray } from "drizzle-orm";
import db from "../../db";
import type { CollectionSyncKind, FieldDefinition } from "../../db/schema";
import { collectionSyncSources, externalAppConnections } from "../../db/schema";
import { getProvider } from "../../external-apps/registry";
import type { SyncArgs, SyncSchedule } from "../../schemas/collection-sync";
import { syncArgsBindSince } from "../../schemas/collection-sync";

/**
 * Where a synced column's values come from, in the four words every surface
 * needs: which app, which action, how fresh, and which collection it owns.
 *
 * ONE reader for four consumers — the record write path (whose refusal names
 * the app), the page field descriptors, the agent's `<team_collections>` block
 * and `describeCollection`. They asked the same question four times and the
 * risk was four different answers to "what is this app called".
 *
 * It deliberately does NOT live in `services/collection-sync/`: that folder
 * owns the ENGINE (create, run, schedule), and a validator on the record write
 * path must not pull the runner's dependency graph in behind it.
 */
export interface SyncProvenance {
  id: string;
  collectionId: string;
  kind: CollectionSyncKind;
  /**
   * The app as a person names it: the connection's own name, else the
   * manifest's display name, else the bare key — which is still better than
   * saying nothing, and is what a source whose connection was deleted falls
   * back to. See `appNameOf` for why the connection wins.
   */
  app: string;
  providerKey: string;
  operation: string;
  /** Last run that landed data. `null` = never succeeded, so the age is unknown. */
  lastSuccessAt: Date | null;
  enabled: boolean;
  lastError: string | null;
  /**
   * How often it runs. Read alongside `lastSuccessAt`, this is what separates
   * "the figures are four hours old and that is normal" from "the figures are
   * four hours old and something is wrong".
   */
  schedule: SyncSchedule;
  /**
   * The source asks the app for what CHANGED, not for everything. It matters
   * to a reader because an incremental source's collection is complete only up
   * to its last full walk — a row deleted upstream survives here until then.
   */
  incremental: boolean;
}

/**
 * The distinct sources filling any of these fields. Empty when none is synced.
 *
 * Narrowed on `typeof`, not on `!== null`: this runs against rows from several
 * selections and against test doubles, and a shape that simply lacks the column
 * answers `undefined` — which `!== null` would have let through, turning "no
 * sync here" into a query for `[undefined]`.
 */
export const syncSourceIdsOf = (
  fieldDefs: readonly { syncSourceId: string | null }[],
): string[] => [
  ...new Set(
    fieldDefs
      .map((def) => def.syncSourceId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  ),
];

/**
 * The app as a person names it — the ONE answer to "what is this app called".
 *
 * THE CONNECTION'S NAME WINS, and the order matters. It defaults to the
 * provider's (`ConnectPanel` prefills it, and even offers
 * `"<Provider> — <account>"` once an account is picked), so for the ordinary
 * connection the two strings are identical and this changes nothing. It differs
 * exactly when the team RENAMED it — and a team renames a connection when it
 * has two of the same product. Preferring the manifest there printed "Front"
 * for both a support inbox and a sales one, in the very sentence meant to say
 * which app fills which column.
 *
 * Exported because a second surface (`describeCollection`, which reads the
 * engine's own richer source list) asks the same question, and two expressions
 * of this fallback chain is two different names for one app in two places the
 * agent reads within a turn.
 */
export const appNameOf = (
  providerKey: string,
  connectionName: string | null,
): string =>
  connectionName ??
  getProvider(providerKey)?.manifest.displayName ??
  providerKey;

const rowsToProvenance = (
  rows: {
    id: string;
    collectionId: string;
    kind: CollectionSyncKind;
    providerKey: string;
    operation: string;
    lastSuccessAt: Date | null;
    enabled: boolean;
    lastError: string | null;
    schedule: SyncSchedule;
    args: SyncArgs;
    connectionName: string | null;
  }[],
): Map<string, SyncProvenance> =>
  new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        collectionId: row.collectionId,
        kind: row.kind,
        app: appNameOf(row.providerKey, row.connectionName),
        providerKey: row.providerKey,
        operation: row.operation,
        lastSuccessAt: row.lastSuccessAt,
        enabled: row.enabled,
        lastError: row.lastError,
        schedule: row.schedule,
        incremental: syncArgsBindSince(row.args),
      },
    ]),
  );

const SELECTION = {
  id: collectionSyncSources.id,
  collectionId: collectionSyncSources.collectionId,
  kind: collectionSyncSources.kind,
  providerKey: collectionSyncSources.providerKey,
  operation: collectionSyncSources.operation,
  lastSuccessAt: collectionSyncSources.lastSuccessAt,
  enabled: collectionSyncSources.enabled,
  lastError: collectionSyncSources.lastError,
  schedule: collectionSyncSources.schedule,
  args: collectionSyncSources.args,
  connectionName: externalAppConnections.displayName,
} as const;

/**
 * Sources by id. NO QUERY for the empty list, which is the case on every write
 * to every collection nothing feeds — i.e. nearly all of them.
 */
export const loadSyncProvenance = async (
  sourceIds: string[],
): Promise<Map<string, SyncProvenance>> => {
  if (sourceIds.length === 0) return new Map();
  const rows = await db
    .select(SELECTION)
    .from(collectionSyncSources)
    .leftJoin(
      externalAppConnections,
      eq(collectionSyncSources.connectionId, externalAppConnections.id),
    )
    .where(inArray(collectionSyncSources.id, sourceIds));
  return rowsToProvenance(rows);
};

/**
 * `syncSourceId` → the app's display name, ready for the write path's refusal.
 * Same zero-query fast path, so the guard costs a `.filter` on a collection
 * nobody syncs.
 */
export const loadSyncSourceApps = async (
  fieldDefs: FieldDefinition[],
): Promise<Map<string, string>> => {
  const provenance = await loadSyncProvenance(syncSourceIdsOf(fieldDefs));
  return new Map([...provenance].map(([id, source]) => [id, source.app]));
};
