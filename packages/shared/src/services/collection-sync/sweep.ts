import { sql } from "drizzle-orm";
import db from "../../db";
import { intFromEnv } from "../../lib/env";
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

/**
 * Sources one sweep pass claims, and how many of them any ONE team may take.
 *
 * `perTeam` is the fairness knob, and it exists because of a shape that is easy
 * to reach: three of a team's sources are slow (an app that answers in 15 s),
 * they are the three most overdue, and they take every seat the worker has. A
 * second team's fifteen-minute source then waits behind three walks of
 * somebody else's. Ordering by `next_run_at` alone cannot fix that — the slow
 * team IS the most overdue, over and over.
 */
const CLAIM_BATCH = intFromEnv("EXTERNAL_SYNC_CLAIM_BATCH", 50);
const CLAIM_PER_TEAM = intFromEnv("EXTERNAL_SYNC_CLAIM_PER_TEAM", 3);

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
  /**
   * This source's rank WITHIN its team, 1 being the most overdue. Handed to
   * BullMQ as the job priority, so every team's first source is served before
   * any team's second — round-robin without a scheduler.
   */
  rank: number;
}

/**
 * Take ownership of every source whose time has come, in ONE statement.
 *
 * THE MUTUAL EXCLUSION IS THREE THINGS, and it used to be one.
 *
 *  1. `FOR UPDATE SKIP LOCKED` on the inner id list, so two replicas sweeping
 *     in the same second pick DIFFERENT rows instead of queueing on the same
 *     ones.
 *  2. The `claimed_at` predicate REPEATED on the outer `UPDATE`. This is the
 *     one that was missing, and the reason it mattered is not obvious: under
 *     READ COMMITTED, when the outer `UPDATE` blocks on a row another
 *     transaction is writing, Postgres re-evaluates only ITS OWN `WHERE`
 *     against the new row version (EPQ) — not the subselect's. With the
 *     predicate living only in the subselect there was nothing left to
 *     re-check, and both sweeps claimed the same source. It was masked in
 *     production by BullMQ collapsing the two jobs onto one `jobId`, which is
 *     luck, not exclusion.
 *  3. The `LIMIT` in a subselect, because Postgres has no `UPDATE … LIMIT`.
 *
 * FAIRNESS is the window function: `row_number()` per team over `next_run_at`,
 * then `rn <= perTeam`. The wrapper around it is not cosmetic either —
 * `FOR UPDATE` cannot be applied to a query with a window function, so the
 * ranking and the locking have to be two levels.
 */
export const claimDueSyncSources = async (
  options: { limit?: number; perTeam?: number } = {},
): Promise<ClaimedSyncSource[]> => {
  const limit = options.limit ?? CLAIM_BATCH;
  const perTeam = options.perTeam ?? CLAIM_PER_TEAM;
  const staleClaim = sql.raw(`${String(SYNC_CLAIM_TIMEOUT_MS)} milliseconds`);
  const result = await db.execute(sql`
    WITH due AS (
      SELECT id,
             team_id,
             next_run_at,
             row_number() OVER (
               PARTITION BY team_id ORDER BY next_run_at ASC, id ASC
             ) AS rn
        FROM collection_sync_sources
       WHERE enabled
         AND next_run_at IS NOT NULL
         AND next_run_at <= now()
         AND (claimed_at IS NULL
              OR claimed_at < now() - interval '${staleClaim}')
    ),
    fair AS (
      SELECT id, rn
        FROM due
       WHERE rn <= ${perTeam}
       ORDER BY rn ASC, next_run_at ASC
       LIMIT ${limit}
    ),
    locked AS (
      SELECT s.id
        FROM collection_sync_sources s
        JOIN fair ON fair.id = s.id
         FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE collection_sync_sources t
       SET claimed_at = now()
      FROM fair
     WHERE t.id = fair.id
       AND t.id IN (SELECT id FROM locked)
       AND (t.claimed_at IS NULL
            OR t.claimed_at < now() - interval '${staleClaim}')
    RETURNING t.id::text AS id, t.team_id::text AS team_id, fair.rn::int AS rn`);
  return result.rows.flatMap((row) => {
    const id = Reflect.get(row, "id");
    const teamId = Reflect.get(row, "team_id");
    const rank = Reflect.get(row, "rn");
    return typeof id === "string" &&
      typeof teamId === "string" &&
      typeof rank === "number"
      ? [{ id, teamId, rank }]
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
  /**
   * The third party asked us to wait this long. The next slot becomes the
   * LATER of the cadence and that wait — coming back on the ordinary interval
   * would only be refused by the governor before a call went out, and would
   * write a failed run for it.
   */
  retryAfterMs?: number;
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
  const scheduled = disabled
    ? null
    : computeNextRunAt({
        schedule: source.schedule,
        consecutiveFailures: failures,
      });
  // A manual source has no `nextRunAt` at all, so a wait cannot give it one:
  // nothing would come back to honour it, and the source would appear to have
  // a schedule it does not have.
  const nextRunAt =
    scheduled === null || outcome.retryAfterMs === undefined
      ? scheduled
      : new Date(
          Math.max(scheduled.getTime(), Date.now() + outcome.retryAfterMs),
        );
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
