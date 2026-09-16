import { sql } from "drizzle-orm";
import db from "../../db";
import type { SyncSchedule } from "../../schemas/collection-sync";
import { SYNC_LIMITS } from "../../schemas/collection-sync";

/**
 * The scheduling half of the engine: who is due, who may run it, and when it
 * runs next.
 *
 * THE SCHEDULING MODEL, restated from the schema because it is the decision
 * everything here follows: one minute-ly sweep claims due sources out of
 * Postgres, rather than one BullMQ repeatable job per source. Repeatable jobs
 * live in Redis, and a source's cadence belongs in the database that already
 * owns the source — a flushed Redis then costs one cycle instead of leaving a
 * team's sync silently dead with nothing to reconcile it against.
 */

/**
 * How long a claim is honoured before another replica may take the source.
 *
 * Must EXCEED `SYNC_LIMITS.runBudgetMs` (10 min), or a long but healthy run
 * gets a second runner half way through and the two fight over the same rows.
 * Fifteen leaves five minutes of slack for the claim, the walk's own teardown
 * and the run row.
 */
export const SYNC_CLAIM_TIMEOUT_MS = 15 * 60_000;

/**
 * Consecutive failures after which a source pauses itself.
 *
 * Ten, with the multiplier capped at 16×, chosen so the sequence spans a real
 * day rather than a bad afternoon. The arithmetic, because the number means
 * nothing without it: the multipliers are 1, 2, 4, 8, 16, then 16 — 111
 * intervals in total, so a 15-minute source reaches the threshold about 28 h
 * after its first failure and an hourly one after about four and a half days.
 *
 * That is the shape the schema comment asks for (an app that has been answering
 * 401 since yesterday should stop asking) and it is deliberately far slower
 * than the workflow breaker's five: a paused workflow is one job that did not
 * run, while a paused source is a whole collection quietly going stale behind a
 * table people are still reading.
 *
 * The arithmetic is asserted, not just described — `collection-sync-schedule`
 * fails if a future edit to either number drops the span back under a day,
 * which is how the first version of these two constants was caught.
 */
export const SYNC_FAILURE_DISABLE_THRESHOLD = 10;
const MAX_BACKOFF_MULTIPLIER = 16;

/** Sources one sweep pass claims. Bounded so a tick stays a tick. */
const CLAIM_BATCH = 50;

/** Exponential, capped. `0` failures is the nominal cadence. */
export const syncBackoffMultiplier = (consecutiveFailures: number): number =>
  consecutiveFailures <= 0
    ? 1
    : Math.min(2 ** (consecutiveFailures - 1), MAX_BACKOFF_MULTIPLIER);

export interface NextRunInput {
  schedule: SyncSchedule;
  consecutiveFailures: number;
  from?: Date;
  /**
   * 0‥1, spread across the interval. Injected so a test is deterministic; in
   * production it is random, which is the point — without it every source a
   * team created in one sitting asks its app at the same second forever.
   */
  jitter?: number;
}

/**
 * When this source should next be picked up, or `null` for "never on its own".
 *
 * A `manual` source has no `nextRunAt` AT ALL, failures included: nothing
 * retries it because nothing scheduled it, and giving it a backoff would put a
 * source the user only ever refreshes by hand into the sweep's index forever.
 */
export const computeNextRunAt = (input: NextRunInput): Date | null => {
  if (input.schedule.mode !== "interval") return null;
  const everyMinutes = Math.max(
    input.schedule.everyMinutes ?? SYNC_LIMITS.minIntervalMinutes,
    SYNC_LIMITS.minIntervalMinutes,
  );
  const base =
    everyMinutes * 60_000 * syncBackoffMultiplier(input.consecutiveFailures);
  // Up to 10% of the interval, added not subtracted: a jittered run is never
  // EARLIER than the cadence a team was promised.
  const jitter = (input.jitter ?? Math.random()) * base * 0.1;
  const from = input.from ?? new Date();
  return new Date(from.getTime() + Math.round(base + jitter));
};

export interface ClaimedSyncSource {
  id: string;
  teamId: string;
}

/**
 * Take ownership of every source whose time has come, in ONE statement.
 *
 * The claim IS the statement: `claimed_at` is both read and written by the same
 * `UPDATE`, so two replicas sweeping at the same second cannot both take a row.
 * The second one blocks on the row lock, re-evaluates its `WHERE` when the lock
 * is released (read-committed re-check), finds `claimed_at` set and skips —
 * which is why there is no advisory lock, no `SELECT … FOR UPDATE` and no
 * leader election anywhere in this path.
 *
 * The `LIMIT` lives in a subselect because Postgres has no `UPDATE … LIMIT`,
 * and it is ordered by `next_run_at` so the most overdue source is never
 * starved by a backlog of fresher ones.
 */
export const claimDueSyncSources = async (
  limit: number = CLAIM_BATCH,
): Promise<ClaimedSyncSource[]> => {
  const staleClaim = sql.raw(`${String(SYNC_CLAIM_TIMEOUT_MS)} milliseconds`);
  const result = await db.execute(sql`
    UPDATE collection_sync_sources
       SET claimed_at = now()
     WHERE id IN (
       SELECT id
         FROM collection_sync_sources
        WHERE enabled
          AND next_run_at IS NOT NULL
          AND next_run_at <= now()
          AND (claimed_at IS NULL
               OR claimed_at < now() - interval '${staleClaim}')
        ORDER BY next_run_at ASC
        LIMIT ${limit}
     )
    RETURNING id::text AS id, team_id::text AS team_id`);
  return result.rows.flatMap((row) => {
    const id = Reflect.get(row, "id");
    const teamId = Reflect.get(row, "team_id");
    return typeof id === "string" && typeof teamId === "string"
      ? [{ id, teamId }]
      : [];
  });
};

/**
 * Claim ONE source, for the job the refresh button enqueued directly rather
 * than through the sweep. Same predicate, same guarantee: `false` means a run
 * is already under way and this job is a duplicate to drop, which is what makes
 * "refresh" idempotent however many times it is pressed.
 */
export const claimSyncSource = async (sourceId: string): Promise<boolean> => {
  const staleClaim = sql.raw(`${String(SYNC_CLAIM_TIMEOUT_MS)} milliseconds`);
  const result = await db.execute(sql`
    UPDATE collection_sync_sources
       SET claimed_at = now()
     WHERE id = ${sourceId}::uuid
       AND (claimed_at IS NULL
            OR claimed_at < now() - interval '${staleClaim}')
    RETURNING id`);
  return result.rows.length > 0;
};

export interface SyncRunOutcome {
  ok: boolean;
  /** Set when `ok` is false — surfaced as the source's `lastError`. */
  error?: string;
  /** A successful run stamps `last_success_at`; a partial one does not. */
  succeededAt?: Date;
}

/**
 * Close the run out on the source row: clear the claim, move the failure
 * counter, compute the next slot, and pause the source if it has been failing
 * long enough to stop being worth asking.
 *
 * One statement, because every field here is a function of the same outcome and
 * a partial write would leave a source claimed by a run that has ended — the
 * one state nothing reclaims for `SYNC_CLAIM_TIMEOUT_MS`.
 */
export const scheduleNextRun = async (
  source: {
    id: string;
    schedule: SyncSchedule;
    consecutiveFailures: number;
  },
  outcome: SyncRunOutcome,
): Promise<{ nextRunAt: Date | null; disabled: boolean }> => {
  const failures = outcome.ok ? 0 : source.consecutiveFailures + 1;
  const disabled = !outcome.ok && failures >= SYNC_FAILURE_DISABLE_THRESHOLD;
  const nextRunAt = disabled
    ? null
    : computeNextRunAt({
        schedule: source.schedule,
        consecutiveFailures: failures,
      });
  const error = outcome.error ?? null;
  // A run that did not succeed leaves `last_success_at` ALONE — it is the
  // freshness the UI shows and the lower bound an incremental read binds, so
  // clearing it on a failure would re-pull the whole collection next time.
  const successStamp =
    outcome.succeededAt === undefined
      ? sql``
      : sql`last_success_at = ${outcome.succeededAt},`;

  await db.execute(sql`
    UPDATE collection_sync_sources
       SET claimed_at = NULL,
           consecutive_failures = ${failures},
           enabled = ${disabled ? sql`false` : sql`enabled`},
           next_run_at = ${nextRunAt},
           last_run_at = now(),
           ${successStamp}
           last_error = ${error},
           last_error_at = ${error === null ? sql`last_error_at` : sql`now()`}
     WHERE id = ${source.id}::uuid`);

  return { nextRunAt, disabled };
};
