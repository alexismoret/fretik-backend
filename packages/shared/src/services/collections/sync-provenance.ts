import { eq, inArray } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { collectionSyncSources, externalAppConnections } from "../../db/schema";
import { getProvider } from "../../external-apps/registry";

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
  kind: "table" | "lookup";
  /**
   * The app as a person names it: the manifest's display name, else the
   * connection's own (an MCP server has no manifest), else the bare key —
   * which is still better than saying nothing, and is what a source whose
   * connection was deleted falls back to.
   */
  app: string;
  providerKey: string;
  operation: string;
  /** Last run that landed data. `null` = never succeeded, so the age is unknown. */
  lastSuccessAt: Date | null;
  enabled: boolean;
  lastError: string | null;
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

const rowsToProvenance = (
  rows: {
    id: string;
    collectionId: string;
    kind: "table" | "lookup";
    providerKey: string;
    operation: string;
    lastSuccessAt: Date | null;
    enabled: boolean;
    lastError: string | null;
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
        app:
          getProvider(row.providerKey)?.manifest.displayName ??
          row.connectionName ??
          row.providerKey,
        providerKey: row.providerKey,
        operation: row.operation,
        lastSuccessAt: row.lastSuccessAt,
        enabled: row.enabled,
        lastError: row.lastError,
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
