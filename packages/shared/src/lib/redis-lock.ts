import { redis } from "./redis";

/**
 * A minimal single-holder mutex over Redis, keyed per conversation. Used by the
 * approval gate to serialize the "is another approval already pending?" check +
 * the fresh-row INSERT across the two producer processes (AI + API), so a
 * conversation can never end up with two pending approvals at once.
 *
 * `SET key token NX PX ttl` acquires; a compare-and-del Lua script releases only
 * OUR token (never a later holder's after a TTL expiry). The critical section is
 * two queries + one insert — well under the TTL — so the TTL is only a
 * crash-safety backstop, not a normal bound.
 */

const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding the per-conversation approval lock, releasing in
 * `finally` so a throw still frees it. Retries with jittered backoff until
 * acquired or `maxWaitMs` elapses (then throws — a stuck lock must not silently
 * drop the write). The random jitter desynchronizes contenders: N parallel tool
 * calls in one step all miss the lock at the same instant, and a fixed delay
 * would make them retry in lockstep and re-collide forever. Mirrors `withSlot`
 * in @fretik/ai (`lib/rate-limit.ts`).
 */
export const withConversationLock = async <T>(
  conversationId: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number; maxWaitMs?: number },
): Promise<T> => {
  const key = `lock:approval-gate:${conversationId}`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const ttlMs = opts?.ttlMs ?? 10_000;
  const maxWaitMs = opts?.maxWaitMs ?? 15_000;
  const start = Date.now();

  for (;;) {
    const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired === "OK") break;
    if (Date.now() - start > maxWaitMs) {
      throw new Error(
        `withConversationLock(${conversationId}) timed out after ${maxWaitMs}ms`,
      );
    }
    await sleep(25 + Math.random() * 50);
  }

  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_LUA, 1, key, token);
  }
};
