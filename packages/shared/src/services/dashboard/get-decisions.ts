import { and, count, eq, gte, sql } from "drizzle-orm";
import db from "../../db";
import { decisionLog } from "../../db/schema";
import type { DashboardDecisionsResponse } from "../../schemas/dashboard";
import { FILING_POINT, ROOT_OPTION } from "../folders/auto-file";

/**
 * What the decision points did for a team: launches avoided and what they
 * would have cost, documents filed and how many were undone.
 *
 * Read from the rows those decisions left behind rather than from counters:
 * a filtered launch is a `workflow_runs` row that never expires, and a filing
 * is a `decision_log` row kept longer than the window. So the card agrees with
 * what anyone can open and count.
 */

export const DECISIONS_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const getDashboardDecisions = async (params: {
  teamId: string;
  now?: Date;
}): Promise<DashboardDecisionsResponse> => {
  const since = new Date(
    (params.now ?? new Date()).getTime() - DECISIONS_WINDOW_DAYS * DAY_MS,
  );

  // Per filtered workflow: its filtered count, and the median tokens of its
  // event runs that actually executed in the same window. A filtered launch
  // is priced at what that workflow's own runs cost, not at a global
  // average that one heavy workflow would skew for every other.
  const saved = await db.execute<{
    runs_avoided: string | null;
    tokens_saved: string | null;
  }>(sql`
    WITH filtered AS (
      SELECT workflow_id, count(*) AS n
      FROM workflow_runs
      WHERE team_id = ${params.teamId}
        AND status = 'filtered'
        AND created_at >= ${since}
      GROUP BY workflow_id
    ),
    executed AS (
      SELECT workflow_id,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY (usage->>'totalTokens')::bigint
             ) AS median
      FROM workflow_runs
      WHERE team_id = ${params.teamId}
        AND trigger_type = 'event'
        AND status IN ('succeeded', 'not_applicable', 'failed')
        AND created_at >= ${since}
        AND (usage->>'totalTokens')::bigint > 0
        AND workflow_id IN (SELECT workflow_id FROM filtered)
      GROUP BY workflow_id
    )
    SELECT sum(filtered.n) AS runs_avoided,
           sum(filtered.n * executed.median) AS tokens_saved
    FROM filtered
    LEFT JOIN executed USING (workflow_id)
  `);
  const row = saved.rows[0];

  const filingWhere = and(
    eq(decisionLog.teamId, params.teamId),
    eq(decisionLog.point, FILING_POINT),
    eq(decisionLog.outcome, "filed"),
    gte(decisionLog.createdAt, since),
  );
  const [filed] = await db
    .select({
      total: count(),
      undone: sql<number>`count(*) FILTER (WHERE ${decisionLog.label} = ${ROOT_OPTION})`,
    })
    .from(decisionLog)
    .where(filingWhere);

  const tokens = row?.tokens_saved
    ? Math.round(Number(row.tokens_saved))
    : null;
  return {
    days: DECISIONS_WINDOW_DAYS,
    runsAvoided: Number(row?.runs_avoided ?? 0),
    tokensSavedEstimate: tokens !== null && tokens > 0 ? tokens : null,
    documentsFiled: filed?.total ?? 0,
    filingsUndone: Number(filed?.undone ?? 0),
  };
};
