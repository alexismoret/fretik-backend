import db from "../../db";
import type { SyncKind, SyncSchedule } from "../../schemas/collection-sync";
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
   * Rows one run reaches at most: `rowCap` for a `table`, and for a `lookup`
   * the records it refreshes per run — which is the number that tells someone
   * their 5 000-row collection takes a day and a half to come round.
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
  kind: SyncKind;
  schedule: SyncSchedule;
  /** `table` only. */
  rowCap?: number;
  /** Rows the action returns per call, when it declares a page size. */
  pageSize: number | undefined;
  /** Ids the action takes per call, when it declares batching (`lookup`). */
  batchMaxItems?: number;
  budget: { requests: number; perSeconds: number } | undefined;
}): SyncCostEstimate => {
  const runsPerDay =
    input.schedule.mode === "interval" && input.schedule.everyMinutes
      ? Math.floor(1440 / input.schedule.everyMinutes)
      : 0;
  const ceiling = syncRunCeiling({
    kind: input.kind,
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
            input.kind === "lookup"
              ? "At this cadence this source would exceed the app's published budget — a lookup spends one request per record unless the action takes several ids at once. Slow the cadence, or fill these columns from a table source instead."
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
  kind: SyncKind;
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
    kind: input.kind,
    schedule: input.schedule,
    ...(input.rowCap === undefined ? {} : { rowCap: input.rowCap }),
    pageSize: input.pageSize,
    ...(input.batchMaxItems === undefined
      ? {}
      : { batchMaxItems: input.batchMaxItems }),
    budget: policy?.perConnection ?? policy?.perProvider,
  });
};
