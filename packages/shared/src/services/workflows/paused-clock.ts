import { type SQL, sql } from "drizzle-orm";
import { workflowRuns } from "../../db/schema";

/**
 * Close the currently-open parked window: fold `now - pausedAt` into the
 * `pausedMs` running total. Pair it with `pausedAt: null` in the same `set`.
 *
 * Shared by the two paths that can end a park — `resumeRunFromApproval` (the
 * human decided) and `finalizeRun` (the run was canceled or timed out while
 * parked) — because getting the expression wrong is silent: the run would
 * simply report the human's latency as worked time again.
 *
 * `COALESCE` makes it a no-op when no window is open (`pausedAt IS NULL`), so
 * both callers can apply it unconditionally. `GREATEST(…, 0)` refuses a
 * negative contribution: `pausedAt` is stamped from the app clock and `now`
 * comes from the caller, so a small backwards skew must never rewind the
 * total.
 */
export const closePausedWindow = (now: Date): SQL<number> =>
  sql<number>`${workflowRuns.pausedMs} + GREATEST(COALESCE((EXTRACT(EPOCH FROM (${now}::timestamptz - ${workflowRuns.pausedAt})) * 1000)::int, 0), 0)`;
