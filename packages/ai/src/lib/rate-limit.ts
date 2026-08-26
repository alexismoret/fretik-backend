// oxlint-disable no-await-in-loop
import { redis } from "@fretik/shared/lib/redis";

/**
 * Redis-backed distributed semaphore.
 *
 * Used by Phase 7b vectorisation to cap the number of concurrent upstream
 * OpenRouter calls across ALL @fretik/ai replicas (the container can be
 * horizontally scaled — an in-process `Promise.all` semaphore would not
 * compose across replicas and burst-ingesting N documents from N workers
 * would blow through provider rate limits).
 *
 * Implementation: one Redis sorted set per limiter key, each in-flight
 * slot is a ZADD entry where the score is the wall-clock timestamp at
 * acquire time. On every acquire we first `ZREMRANGEBYSCORE` stale
 * entries (older than `holdTimeoutMs`) so a replica that crashed mid-call
 * can't leak its slot forever, then `ZCARD` the remaining live slots and
 * race the limit.
 *
 * Why a ZSET instead of INCR+TTL:
 *   - `INCR` + `EXPIRE` leaks on crashes because EXPIRE is refreshed by
 *     every acquire (multi-caller keep-alive).
 *   - ZSET scores are per-entry so each slot has its own effective TTL —
 *     no "the whole counter expires at once" race.
 *
 * Usage:
 *   const release = await acquireSlot("openrouter:cheap", 5, 60_000);
 *   try { ... } finally { await release(); }
 */

interface AcquireOptions {
  /** Upper bound on live slots for this key across all replicas. */
  maxConcurrent: number;
  /**
   * Safety cap on how long a slot is considered live. If a replica crashes
   * without releasing, its slot is reclaimed after this many ms. Should be
   * comfortably larger than the worst-case upstream call duration — we
   * don't want to race-release a legitimately slow request.
   */
  holdTimeoutMs: number;
  /** Initial wait between re-acquire attempts when the limit is hit. */
  retryBaseMs?: number;
  /** Upper bound on a single wait between retries. */
  retryMaxMs?: number;
  /** Abort after this total wait and throw — prevents unbounded blocking. */
  maxWaitMs?: number;
}

const DEFAULT_RETRY_BASE_MS = 50;
const DEFAULT_RETRY_MAX_MS = 500;
const DEFAULT_MAX_WAIT_MS = 120_000;

const buildKey = (key: string): string => `ratelimit:sem:${key}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const makeToken = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Acquires one concurrency slot. Returns a `release()` function. If the
 * caller forgets to release, the slot is reclaimed after `holdTimeoutMs`
 * — so there's no permanent leak, just a temporary reduction in
 * effective capacity.
 */
export const acquireSlot = async (
  key: string,
  maxConcurrent: number,
  holdTimeoutMs: number,
  opts: Partial<Omit<AcquireOptions, "maxConcurrent" | "holdTimeoutMs">> = {},
): Promise<() => Promise<void>> => {
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const redisKey = buildKey(key);
  const token = makeToken();
  const start = Date.now();

  let attempt = 0;
  while (true) {
    const now = Date.now();
    const staleCutoff = now - holdTimeoutMs;

    // Drop any slot older than the hold cap (crashed replicas).
    await redis.zremrangebyscore(redisKey, "-inf", staleCutoff);

    // Claim a slot optimistically, then check whether we're under cap.
    await redis.zadd(redisKey, now, token);
    // Set an outer key TTL as belt-and-suspenders: if the limiter is
    // idle for 2× the hold cap the whole key disappears instead of
    // lingering as an empty ZSET. Refreshing on every acquire is fine.
    await redis.pexpire(redisKey, holdTimeoutMs * 2);

    const liveCount = await redis.zcard(redisKey);
    if (liveCount <= maxConcurrent) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await redis.zrem(redisKey, token);
      };
    }

    // Over cap — release our optimistic slot and back off with jitter.
    await redis.zrem(redisKey, token);

    if (now - start > maxWaitMs) {
      throw new Error(
        `acquireSlot(${key}) timed out after ${maxWaitMs}ms (limit=${maxConcurrent})`,
      );
    }

    const backoff = Math.min(retryMaxMs, retryBaseMs * Math.pow(2, attempt));
    const jittered = backoff * (0.5 + Math.random());
    await sleep(jittered);
    attempt++;
  }
};

/**
 * Convenience wrapper — runs `fn` inside an acquired slot, releasing in
 * `finally` so thrown errors still free the limiter.
 */
export const withSlot = async <T>(
  key: string,
  maxConcurrent: number,
  holdTimeoutMs: number,
  fn: () => Promise<T>,
  opts: Partial<Omit<AcquireOptions, "maxConcurrent" | "holdTimeoutMs">> = {},
): Promise<T> => {
  // A waiter must be allowed to wait at least as long as a holder is
  // allowed to hold, or a legitimately slow holder makes its neighbour
  // THROW instead of queueing — which is what the 120 s default did to the
  // E2B mutex, whose hold cap is 5.5 min. Raise the floor for long holds;
  // never lower it for the short ones (the cheap-model and embedding
  // queues hold for 15-30 s but are worth waiting the full 120 s for).
  const release = await acquireSlot(key, maxConcurrent, holdTimeoutMs, {
    maxWaitMs: Math.max(holdTimeoutMs, DEFAULT_MAX_WAIT_MS),
    ...opts,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
};
