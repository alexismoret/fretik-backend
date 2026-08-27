import { redis } from "./redis";

/**
 * A minimal single-holder mutex over Redis.
 *
 * `SET key token NX PX ttl` acquires; a compare-and-del Lua script releases only
 * OUR token (never a later holder's after a TTL expiry). The TTL is a
 * crash-safety backstop, not a normal bound — pick one that comfortably exceeds
 * the longest the critical section can legitimately take, because an expiry
 * under a live holder is the one way two runners can overlap.
 *
 * Two callers today: the approval gate, which serialises the "is another
 * approval already pending?" check + INSERT across the AI and API processes;
 * and `withConnectionSlot`, which keeps a serial-only third party from being
 * asked two questions at once on the same account.
 */

const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the wait budget runs out. Callers translate it — what a stuck
 *  lock MEANS is theirs to say, not this file's. */
export class RedisLockTimeoutError extends Error {
  constructor(
    readonly key: string,
    readonly maxWaitMs: number,
  ) {
    super(`lock ${key} not acquired within ${maxWaitMs.toString()}ms`);
    this.name = "RedisLockTimeoutError";
  }
}

/**
 * Run `fn` while holding `key`, releasing in `finally` so a throw still frees
 * it. Retries with jittered backoff until acquired or `maxWaitMs` elapses (then
 * throws — a stuck lock must not silently drop the work). The random jitter
 * desynchronizes contenders: N parallel callers all miss the lock at the same
 * instant, and a fixed delay would make them retry in lockstep and re-collide
 * forever. Mirrors `withSlot` in @fretik/ai (`lib/rate-limit.ts`).
 */
export const withRedisLock = async <T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number; maxWaitMs?: number },
): Promise<T> => {
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const ttlMs = opts?.ttlMs ?? 10_000;
  const maxWaitMs = opts?.maxWaitMs ?? 15_000;
  const start = Date.now();

  for (;;) {
    const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired === "OK") break;
    if (Date.now() - start > maxWaitMs) {
      throw new RedisLockTimeoutError(key, maxWaitMs);
    }
    await sleep(25 + Math.random() * 50);
  }

  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token);
  }
};

/** The approval gate's per-conversation lock. */
export const withConversationLock = async <T>(
  conversationId: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number; maxWaitMs?: number },
): Promise<T> =>
  await withRedisLock(`lock:approval-gate:${conversationId}`, fn, opts);
