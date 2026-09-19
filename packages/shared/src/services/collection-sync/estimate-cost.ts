import db from "../../db";
import type { SyncSchedule } from "../../schemas/collection-sync";
import { resolveGovernorPolicy } from "../external-apps/exec/governor/policy";

/**
 * What a cadence would spend against what the app says it allows.
 *
 * Shown before a source is created, because that is the only moment the answer
 * can change anything: once it is scheduled, an over-budget source does not
 * fail loudly — it gets throttled by the governor, runs late, and looks like a
 * slow app.
 *
 * Deliberately a WORST case, and labelled as one. Nobody knows at this point
 * how many rows the collection will hold, so the calls-per-run figure assumes
 * the walk goes all the way to `rowCap`. An estimate that guessed low would be
 * worse than none: the whole use of the number is to catch a cadence that
 * cannot fit, and that comparison only works against the ceiling.
 */
export interface SyncCostEstimate {
  runsPerDay: number;
  callsPerRunAtRowCap: number;
  callsPerDayAtRowCap: number;
  /** The app's published budget, converted to a day. Absent when it publishes
   * none — most APIs are generous enough not to. */
  appLimitPerDay?: number;
  /** Present only when the estimate exceeds the budget. */
  warning?: string;
}

export const estimateSyncCost = (input: {
  schedule: SyncSchedule;
  rowCap: number;
  /** Rows the action returns per call, when it declares a page size. */
  pageSize: number | undefined;
  budget: { requests: number; perSeconds: number } | undefined;
}): SyncCostEstimate => {
  const runsPerDay =
    input.schedule.mode === "interval" && input.schedule.everyMinutes
      ? Math.floor(1440 / input.schedule.everyMinutes)
      : 0;
  const callsPerRunAtRowCap =
    input.pageSize === undefined || input.pageSize <= 0
      ? 1
      : Math.ceil(input.rowCap / input.pageSize);
  const callsPerDayAtRowCap = runsPerDay * callsPerRunAtRowCap;
  const appLimitPerDay =
    input.budget === undefined
      ? undefined
      : Math.floor((input.budget.requests * 86_400) / input.budget.perSeconds);
  return {
    runsPerDay,
    callsPerRunAtRowCap,
    callsPerDayAtRowCap,
    ...(appLimitPerDay === undefined ? {} : { appLimitPerDay }),
    ...(appLimitPerDay !== undefined && callsPerDayAtRowCap > appLimitPerDay
      ? {
          warning:
            "At this cadence a full collection would exceed the app's published budget. Slow the cadence, cap the rows, or bind an incremental argument.",
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
  schedule: SyncSchedule;
  rowCap: number;
  pageSize: number | undefined;
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
    schedule: input.schedule,
    rowCap: input.rowCap,
    pageSize: input.pageSize,
    budget: policy?.perConnection ?? policy?.perProvider,
  });
};
