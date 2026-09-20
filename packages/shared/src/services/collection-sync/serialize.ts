import { inArray } from "drizzle-orm";
import db from "../../db";
import type {
  CollectionSyncRun,
  CollectionSyncSource,
  ExternalAppConnection,
} from "../../db/schema";
import { externalAppConnections } from "../../db/schema";
import { getAction, getProvider } from "../../external-apps/registry";
import { chunkForBulk } from "../../lib/db-bulk";
import type {
  SyncRunResponse,
  SyncSourceHealth,
  SyncSourceResponse,
} from "../../schemas/collection-sync";
import {
  syncArgsBindSince,
  syncReadStrategy,
} from "../../schemas/collection-sync";
import { isMcpConnection } from "../external-apps/mcp/connection-kind";
import { getSnapshotForConnection } from "../external-apps/mcp/snapshot-store";
import { SYNC_CLAIM_TIMEOUT_MS } from "./sweep";

/**
 * Source row → the DTO every surface reads.
 *
 * Two things here are not simple field copying and are the reason this is a
 * service rather than a mapper:
 *
 *  - `health` is DERIVED, in one place, so the banner, the collection header,
 *    the settings list and the agent all say the same word about the same
 *    source. A UI that computed it would compute it slightly differently on
 *    each screen, and "is this broken" is exactly the question that must not
 *    have two answers.
 *  - the connection and the operation's one-line summary are DENORMALISED into
 *    the response, so drawing a list of sources costs no extra fetch. Which is
 *    why this file takes a pre-loaded context instead of reading per source:
 *    serializing ten sources one by one would be ten connection reads and ten
 *    snapshot reads, and the list endpoint is the exact place that matters.
 */

export interface SyncSourceContext {
  connections: Map<string, ExternalAppConnection>;
  /** `<connectionId>:<operation>` → the action's one-line summary. */
  summaries: Map<string, string>;
  /** Sources with a run in flight, by source id. */
  running: Set<string>;
  lastRuns: Map<string, CollectionSyncRun>;
}

const summaryKey = (connectionId: string, operation: string): string =>
  `${connectionId}:${operation}`;

/**
 * Everything a batch of sources needs to serialize, in a fixed number of reads:
 * one for the connections, and one MCP snapshot per DISTINCT MCP connection
 * (the manifest ones come from the in-memory registry and cost nothing).
 */
export const loadSyncSourceContext = async (
  sources: readonly CollectionSyncSource[],
  options?: { lastRuns?: Map<string, CollectionSyncRun> },
): Promise<SyncSourceContext> => {
  const connectionIds = [
    ...new Set(
      sources
        .map((source) => source.connectionId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const connections = new Map<string, ExternalAppConnection>();
  for (const chunk of chunkForBulk(connectionIds)) {
    const rows = await db
      .select()
      .from(externalAppConnections)
      .where(inArray(externalAppConnections.id, chunk));
    for (const row of rows) connections.set(row.id, row);
  }

  const summaries = new Map<string, string>();
  const mcpConnectionIds = new Set<string>();
  for (const source of sources) {
    if (source.connectionId === null) continue;
    const connection = connections.get(source.connectionId);
    if (connection === undefined) continue;
    if (isMcpConnection(connection)) {
      mcpConnectionIds.add(connection.id);
      continue;
    }
    const resolved = getAction(`${connection.providerKey}.${source.operation}`);
    if (resolved?.action.summary !== undefined) {
      summaries.set(
        summaryKey(connection.id, source.operation),
        resolved.action.summary,
      );
    }
  }
  for (const connectionId of mcpConnectionIds) {
    const connection = connections.get(connectionId);
    if (connection === undefined) continue;
    const snapshot = await getSnapshotForConnection(connection);
    if (snapshot === undefined) continue;
    for (const action of snapshot.descriptor.actions) {
      summaries.set(summaryKey(connectionId, action.name), action.summary);
    }
  }

  // A claim that has EXPIRED is not a run in flight. Without the second half of
  // this predicate a runner killed mid-walk left its source spinning in the UI
  // for ever, because nothing clears `claimed_at` on a crash — while the claim
  // query has always read it this way, which is how the two disagreed. A
  // suspended leg renews the stamp, so a two-hour walk stays "running"
  // throughout.
  const liveClaim = Date.now() - SYNC_CLAIM_TIMEOUT_MS;

  return {
    connections,
    summaries,
    running: new Set(
      sources
        .filter(
          (source) =>
            source.claimedAt !== null && source.claimedAt.getTime() > liveClaim,
        )
        .map((s) => s.id),
    ),
    lastRuns: options?.lastRuns ?? new Map<string, CollectionSyncRun>(),
  };
};

/**
 * One word for "what state is this source in", in the order a person triages.
 *
 * `paused` first because a switch the user threw explains everything after it,
 * and `disconnected` second because a missing connection is not the source's
 * fault and is fixed somewhere else entirely. An error outranks `never_run`:
 * a source that ran once and failed has more to say than "nothing yet".
 */
export const syncSourceHealth = (
  source: Pick<
    CollectionSyncSource,
    | "enabled"
    | "connectionId"
    | "consecutiveFailures"
    | "lastError"
    | "lastSuccessAt"
    | "schedule"
  >,
  connection: ExternalAppConnection | undefined,
  now: Date = new Date(),
): SyncSourceHealth => {
  if (!source.enabled) return "paused";
  if (source.connectionId === null || connection === undefined) {
    return "disconnected";
  }
  if (connection.status !== "active") return "disconnected";
  if (source.consecutiveFailures > 0 || source.lastError !== null) {
    return "error";
  }
  if (source.lastSuccessAt === null) return "never_run";
  if (source.schedule.mode === "interval") {
    const everyMinutes = source.schedule.everyMinutes ?? 0;
    // Two cycles, not one. A run that lands a minute late is not stale, and a
    // banner that cries at every jittered tick is a banner people stop reading.
    const staleAfterMs = everyMinutes * 60_000 * 2;
    if (
      staleAfterMs > 0 &&
      now.getTime() - source.lastSuccessAt.getTime() > staleAfterMs
    ) {
      return "stale";
    }
  }
  return "ok";
};

export const serializeSyncRun = (run: CollectionSyncRun): SyncRunResponse => ({
  id: run.id,
  syncSourceId: run.syncSourceId,
  status: run.status,
  trigger: run.trigger,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  createdCount: run.createdCount,
  updatedCount: run.updatedCount,
  unchangedCount: run.unchangedCount,
  orphanCount: run.orphanCount,
  failedCount: run.failedCount,
  missingCount: run.missingCount,
  unmatchedCount: run.unmatchedCount,
  upstreamCalls: run.upstreamCalls,
  truncated: run.truncated,
  legs: run.legs,
  stopReason: run.stopReason,
  error: run.error,
  triggeredByUserId: run.triggeredByUserId,
});

export const serializeSyncSource = (
  source: CollectionSyncSource,
  context: SyncSourceContext,
): SyncSourceResponse => {
  const connection =
    source.connectionId === null
      ? undefined
      : context.connections.get(source.connectionId);
  const lastRun = context.lastRuns.get(source.id);
  return {
    id: source.id,
    collectionId: source.collectionId,
    kind: source.kind,
    connectionId: source.connectionId,
    providerKey: source.providerKey,
    connection:
      connection === undefined
        ? null
        : {
            id: connection.id,
            displayName: connection.displayName,
            status: connection.status,
            // NULL for a manifest provider — its icon lives in the catalogue
            // the frontend already holds, keyed by `providerKey`.
            iconUrl: connection.iconUrl,
          },
    operation: source.operation,
    operationSummary:
      connection === undefined
        ? null
        : (context.summaries.get(summaryKey(connection.id, source.operation)) ??
          null),
    args: source.args,
    resultPath: source.resultPath,
    externalIdPath: source.externalIdPath,
    matchFieldKey: source.matchFieldKey,
    // Derived here rather than stored, so every reader — the form's cost line,
    // the agent's `describeCollection`, the run list — gets the same answer
    // from the same arguments.
    read: source.kind === "table" ? "walk" : syncReadStrategy(source.args),
    // From the registry, not from the row: whether an app notifies is a
    // property of the integration, and storing a copy per source would go stale
    // the day an operator registers the webhook URL upstream.
    notifiesChanges:
      getProvider(source.providerKey)?.manifest.notifiesChanges === true,
    fieldMapping: source.fieldMapping,
    schedule: source.schedule,
    orphanPolicy: source.orphanPolicy,
    rowCap: source.rowCap,
    enabled: source.enabled,
    lastRunAt: source.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null,
    lastError: source.lastError,
    lastErrorAt: source.lastErrorAt?.toISOString() ?? null,
    consecutiveFailures: source.consecutiveFailures,
    nextRunAt: source.nextRunAt?.toISOString() ?? null,
    // The claim IS the in-flight flag: it is taken before the run starts and
    // cleared when it ends, so there is no second piece of state to keep in
    // step with it.
    running: context.running.has(source.id),
    // Both halves or neither: the stamp says WHEN and the reason says WHY, and
    // a confirmation offered without the second is a person clicking blind.
    pendingFullResync:
      source.fullResyncRequestedAt === null
        ? null
        : {
            requestedAt: source.fullResyncRequestedAt.toISOString(),
            reason: source.fullResyncReason ?? "",
          },
    // The source's own args are the declaration: binding `{"$since": true}` IS
    // what makes a read incremental, whatever the action would have allowed.
    incremental: syncArgsBindSince(source.args),
    lastFullWalkAt: source.lastFullWalkAt?.toISOString() ?? null,
    health: syncSourceHealth(source, connection),
    lastRun: lastRun === undefined ? null : serializeSyncRun(lastRun),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
};
