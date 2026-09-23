import db from "../../db";
import type {
  SyncReadStrategy,
  SyncSchedule,
} from "../../schemas/collection-sync";
import { syncRunCeiling } from "../../schemas/collection-sync";
import { resolveGovernorPolicy } from "../external-apps/exec/governor/policy";

/**
 * What a cadence would spend against what the app says it allows.
 *
 * Shown before a source is created, because that is the only moment the answer
 * can change anything: once it is scheduled, an over-budget source does not
 * fail loudly — it gets throttled by the governor, runs late, and looks like a
 * slow app.
 *
 * Deliberately a WORST case — see `syncRunCeiling`, which owns the arithmetic
 * and the reason it has to be a ceiling. This function's own job is only to
 * turn one run into a day and compare it with the app's published budget.
 */
export interface SyncCostEstimate {
  runsPerDay: number;
  /**
   * Rows one run reaches at most: `rowCap` for a walked source, and for a
   * per-record one the records it refreshes per run — which is the number that
   * tells someone their 5 000-row collection takes a day and a half to come
   * round.
   */
  recordsPerRun: number;
  callsPerRun: number;
  callsPerDay: number;
  /** The app's published budget, converted to a day. Absent when it publishes
   * none — most APIs are generous enough not to. */
  appLimitPerDay?: number;
  /** Present only when the estimate exceeds the budget. */
  warning?: string;
}

export const estimateSyncCost = (input: {
  /**
   * How the app is read. NOT the kind: a `columns` source walked by list costs
   * what a `table` costs, and the same source read per record costs two orders
   * of magnitude more.
   */
  read: SyncReadStrategy;
  schedule: SyncSchedule;
  /** Walked sources only. */
  rowCap?: number;
  /** Rows the action returns per call, when it declares a page size. */
  pageSize: number | undefined;
  /** Ids the action takes per call, when it declares batching (per-record). */
  batchMaxItems?: number;
  budget: { requests: number; perSeconds: number } | undefined;
}): SyncCostEstimate => {
  const runsPerDay =
    input.schedule.mode === "interval" && input.schedule.everyMinutes
      ? Math.floor(1440 / input.schedule.everyMinutes)
      : 0;
  const ceiling = syncRunCeiling({
    read: input.read,
    ...(input.rowCap === undefined ? {} : { rowCap: input.rowCap }),
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
    ...(input.batchMaxItems === undefined
      ? {}
      : { batchMaxItems: input.batchMaxItems }),
  });
  const callsPerDay = runsPerDay * ceiling.calls;
  const appLimitPerDay =
    input.budget === undefined
      ? undefined
      : Math.floor((input.budget.requests * 86_400) / input.budget.perSeconds);
  return {
    runsPerDay,
    recordsPerRun: ceiling.records,
    callsPerRun: ceiling.calls,
    callsPerDay,
    ...(appLimitPerDay === undefined ? {} : { appLimitPerDay }),
    ...(appLimitPerDay !== undefined && callsPerDay > appLimitPerDay
      ? {
          warning:
            input.read === "row"
              ? "At this cadence this source would exceed the app's published budget: asking about one record at a time spends one request per row. If the app has a list of these, match on a column instead and it costs one request per page; otherwise slow the cadence."
              : "At this cadence a full collection would exceed the app's published budget. Slow the cadence, cap the rows, or bind an incremental argument.",
        }
      : {}),
  };
};

/**
 * The same estimate, for a connection named by id.
 *
 * The budget comes from the connection row and its manifest, never from the
 * governor's counters: those are a decision surface, and a second reader of
 * them would be a second opinion (see `readUpstreamStats`). What a preview
 * needs is the PUBLISHED allowance, which is a property of the app.
 */
export const estimateSyncCostForConnection = async (input: {
  teamId: string;
  connectionId: string;
  read: SyncReadStrategy;
  schedule: SyncSchedule;
  rowCap?: number;
  pageSize: number | undefined;
  batchMaxItems?: number;
}): Promise<SyncCostEstimate> => {
  const connection = await db.query.externalAppConnections.findFirst({
    where: { id: input.connectionId, teamId: input.teamId },
    columns: {
      id: true,
      providerKey: true,
      displayName: true,
      concurrencyMode: true,
      rateLimitRequests: true,
      rateLimitPerSeconds: true,
      maxConcurrent: true,
    },
  });
  const policy =
    connection === undefined ? undefined : resolveGovernorPolicy(connection);
  return estimateSyncCost({
    read: input.read,
    schedule: input.schedule,
    ...(input.rowCap === undefined ? {} : { rowCap: input.rowCap }),
    pageSize: input.pageSize,
    ...(input.batchMaxItems === undefined
      ? {}
      : { batchMaxItems: input.batchMaxItems }),
    budget: policy?.perConnection ?? policy?.perProvider,
  });
};
