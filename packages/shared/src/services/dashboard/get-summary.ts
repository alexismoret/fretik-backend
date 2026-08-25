import { and, count, eq, gte, sql } from "drizzle-orm";
import db from "../../db";
import { collectionRecords, documents, workflowRuns } from "../../db/schema";
import type { DashboardSummaryResponse } from "../../schemas/dashboard";

const DAY_MS = 24 * 60 * 60 * 1000;
const SPARK_DAYS = 14;

/** UTC day key `YYYY-MM-DD`, matching the SQL bucket below. */
const utcDayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Fill a fixed window of days (oldest → newest) from sparse grouped rows. */
const buildDaySeries = (
  rows: { day: string; count: number }[],
  days: number,
  now: Date,
): { day: string; count: number }[] => {
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  const series: { day: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = utcDayKey(new Date(now.getTime() - i * DAY_MS));
    series.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return series;
};

/** Week-over-week % change of two equal-length halves; null when the prior
 *  half is empty (no baseline to compare against). */
const weekTrend = (series: number[]): number | null => {
  const half = Math.floor(series.length / 2);
  const prev = series.slice(0, half).reduce((a, b) => a + b, 0);
  const curr = series.slice(half).reduce((a, b) => a + b, 0);
  if (prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 100);
};

/** Grouped daily counts of a timestamp column for a team, bucketed in UTC. */
const dailyCounts = async (
  column: typeof documents.createdAt | typeof collectionRecords.createdAt,
  table: typeof documents | typeof collectionRecords,
  teamId: string,
  since: Date,
): Promise<{ day: string; count: number }[]> => {
  const rows = await db
    .select({
      day: sql<string>`to_char((${column} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`,
      count: count(),
    })
    .from(table)
    .where(and(eq(table.teamId, teamId), gte(column, since)))
    .groupBy(sql`(${column} AT TIME ZONE 'UTC')::date`);
  return rows;
};

/**
 * The home "Workspace pulse" + "This week" aggregates in one payload: total
 * confirmed records with a 14-day sparkline, 7-day workflow-run volume and
 * success rate, and the current week's documents-processed bar series. All
 * counts are scoped to the team; each sub-query is team-and-timestamp indexed.
 */
export const getDashboardSummary = async (data: {
  teamId: string;
}): Promise<DashboardSummaryResponse> => {
  const { teamId } = data;
  const now = new Date();
  const since14 = new Date(now.getTime() - SPARK_DAYS * DAY_MS);
  const since7 = new Date(now.getTime() - 7 * DAY_MS);

  const [recordsTotalRow, recordDaily, runRows, docDaily] = await Promise.all([
    db
      .select({ count: count() })
      .from(collectionRecords)
      .where(
        and(
          eq(collectionRecords.teamId, teamId),
          eq(collectionRecords.status, "confirmed"),
        ),
      ),
    dailyCounts(
      collectionRecords.createdAt,
      collectionRecords,
      teamId,
      since14,
    ),
    db
      .select({ status: workflowRuns.status, count: count() })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.teamId, teamId),
          gte(workflowRuns.createdAt, since7),
        ),
      )
      .groupBy(workflowRuns.status),
    dailyCounts(documents.createdAt, documents, teamId, since14),
  ]);

  const recordSeries = buildDaySeries(recordDaily, SPARK_DAYS, now);
  const recordsSpark = recordSeries.map((d) => d.count);

  const runsByStatus = new Map(runRows.map((r) => [r.status, r.count]));
  const runsTotal = runRows.reduce((a, r) => a + r.count, 0);
  const terminal =
    (runsByStatus.get("succeeded") ?? 0) +
    (runsByStatus.get("failed") ?? 0) +
    (runsByStatus.get("canceled") ?? 0);
  const successRate =
    terminal === 0
      ? null
      : Math.round(((runsByStatus.get("succeeded") ?? 0) / terminal) * 100);

  const docSeriesFull = buildDaySeries(docDaily, SPARK_DAYS, now);
  const docThisWeek = docSeriesFull.slice(SPARK_DAYS - 7);

  return {
    records: {
      total: recordsTotalRow[0]?.count ?? 0,
      trendPct: weekTrend(recordsSpark),
    },
    recordsSpark,
    runs7d: { total: runsTotal, successRate },
    documentsThisWeek: {
      series: docThisWeek,
      total: docThisWeek.reduce((a, d) => a + d.count, 0),
      trendPct: weekTrend(docSeriesFull.map((d) => d.count)),
    },
  };
};
