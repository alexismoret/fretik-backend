import { and, desc, eq, inArray } from "drizzle-orm";
import db from "../../db";
import type {
  CollectionSyncRun,
  CollectionSyncSource,
  ExternalAppConnection,
} from "../../db/schema";
import { collectionSyncRuns, externalAppConnections } from "../../db/schema";
import { getAction } from "../../external-apps/registry";
import { chunkForBulk } from "../../lib/db-bulk";
import {
  SYNC_LIMITS,
  type SyncRunResponse,
  type SyncSourceHealth,
  type SyncSourceResponse,
} from "../../schemas/collection-sync";
import { isMcpConnection } from "../external-apps/mcp/connection-kind";
import { getSnapshotForConnection } from "../external-apps/mcp/snapshot-store";

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

  return {
    connections,
    summaries,
    running: new Set(
      sources.filter((source) => source.claimedAt !== null).map((s) => s.id),
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
  upstreamCalls: run.upstreamCalls,
  truncated: run.truncated,
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
    health: syncSourceHealth(source, connection),
    lastRun: lastRun === undefined ? null : serializeSyncRun(lastRun),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
};

/**
 * Each source's most recent run, in ONE query for the whole set.
 *
 * Read whole and reduced in memory rather than with a `DISTINCT ON`: retention
 * caps a source at `SYNC_LIMITS.runHistoryLimit` runs (`run-source.ts` trims
 * post-insert), so the worst case is twenty rows per source — bounded by a
 * contract, which is the only thing that makes "read them all" a fair trade for
 * a simpler statement.
 */
const loadLastRuns = async (
  sourceIds: readonly string[],
): Promise<Map<string, CollectionSyncRun>> => {
  const lastRuns = new Map<string, CollectionSyncRun>();
  if (sourceIds.length === 0) return lastRuns;
  for (const chunk of chunkForBulk([...sourceIds])) {
    const rows = await db.query.collectionSyncRuns.findMany({
      where: { syncSourceId: { in: chunk } },
      orderBy: { startedAt: "desc" },
    });
    for (const row of rows) {
      if (!lastRuns.has(row.syncSourceId)) lastRuns.set(row.syncSourceId, row);
    }
  }
  return lastRuns;
};

/**
 * Every source of a team, or of one collection — the list endpoint and the
 * collection header both read this.
 *
 * Fixed number of queries whatever the count: one for the sources, one for
 * their runs, one for the connections, and one MCP snapshot per distinct MCP
 * connection. Serializing one at a time would be four reads PER SOURCE, and a
 * settings page listing a dozen is exactly where that shows.
 */
export const listSyncSources = async (params: {
  teamId: string;
  collectionId?: string;
}): Promise<SyncSourceResponse[]> => {
  const sources = await db.query.collectionSyncSources.findMany({
    where: {
      teamId: params.teamId,
      ...(params.collectionId !== undefined
        ? { collectionId: params.collectionId }
        : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (sources.length === 0) return [];
  const context = await loadSyncSourceContext(sources, {
    lastRuns: await loadLastRuns(sources.map((source) => source.id)),
  });
  return sources.map((source) => serializeSyncSource(source, context));
};

/**
 * One source, or `undefined` when it is not this team's — never a throw and
 * never a distinction between "gone" and "someone else's", which is the same
 * rule every other by-id read here follows.
 */
export const getSyncSource = async (params: {
  id: string;
  teamId: string;
}): Promise<SyncSourceResponse | undefined> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: params.id, teamId: params.teamId },
  });
  if (source === undefined) return undefined;
  const context = await loadSyncSourceContext([source], {
    lastRuns: await loadLastRuns([source.id]),
  });
  return serializeSyncSource(source, context);
};

/**
 * A source's recent runs, newest first — the short history behind "why is this
 * figure from yesterday".
 *
 * `teamId` is a predicate and not a comment: without it any run id would read
 * any team's sync history. A source that is not this team's simply has no runs.
 */
export const listSyncRuns = async (params: {
  syncSourceId: string;
  teamId: string;
  limit?: number;
}): Promise<SyncRunResponse[]> => {
  const rows = await db
    .select()
    .from(collectionSyncRuns)
    .where(
      and(
        eq(collectionSyncRuns.syncSourceId, params.syncSourceId),
        eq(collectionSyncRuns.teamId, params.teamId),
      ),
    )
    .orderBy(desc(collectionSyncRuns.startedAt))
    .limit(
      Math.min(
        params.limit ?? SYNC_LIMITS.runHistoryLimit,
        SYNC_LIMITS.runHistoryLimit,
      ),
    );
  return rows.map(serializeSyncRun);
};
