import { redis } from "@fretik/shared/lib/redis";

/**
 * Short-lived result cache for the web tools.
 *
 * Both reference agents cache web results for ~15 minutes (OpenClaw caches
 * `web_search` by query and `web_fetch` by URL; its TTL is configurable and
 * zero disables it), and the reason applies here twice over: an agent re-runs
 * near-identical queries across the steps of one turn, and a sub-agent
 * dispatched on the same task repeats its parent's. Every hit is a provider
 * call not billed and a round-trip not waited for.
 *
 * Three rules separate this from `selectOrCache` in `@fretik/shared`, and each
 * exists because of what a web result is:
 *
 *  - **An empty result is never stored.** Zero hits is usually a transient
 *    provider state, and pinning it for fifteen minutes turns one bad moment
 *    into an agent that cannot find anything about a subject for a quarter of
 *    an hour. `selectOrCache` stores any non-nullish value, which is right for
 *    a database row and wrong here.
 *  - **A failed or aborted call is never stored.** The caller only reaches the
 *    write path on success, and an abort rejects before it.
 *  - **A hit is labelled.** The payload carries `cached: true` so a reader of
 *    the trace can tell a fast turn from a lucky one.
 */

const VERSION = "v1";

/**
 * Key from the operation and its normalized arguments.
 *
 * Hashed to keep the raw query out of the key space — Redis keys surface in
 * logs, `SCAN` output and metrics. It is a tidiness measure and not a privacy
 * boundary: whoever can read these keys can read the cached VALUES next to
 * them, which hold the results in full.
 *
 * `Bun.hash` here despite the project rule banning it for a persisted hash,
 * because that rule's reason does not reach this key. It is banned because
 * Wyhash is an alias with no cross-version stability guarantee, so a Bun
 * upgrade silently changes every digest — which for a `content_hash` means
 * re-embedding the entire corpus. The blast radius here is one cold cache
 * window after a deploy that already restarted the process. Collisions are the
 * same non-event: one wrong hit inside a 15-minute TTL, at 64 bits.
 *
 * Base-36 keeps it short in the key space.
 */
export const webCacheKey = (
  operation: string,
  provider: string,
  payload: unknown,
): string => {
  const digest = Bun.hash(JSON.stringify(payload)).toString(36);
  return `web:${VERSION}:${operation}:${provider}:${digest}`;
};

export interface CachedEnvelope<T> {
  value: T;
  cached: boolean;
}

/**
 * Run `compute`, or return a cached result when one is fresh.
 *
 * `isWorthCaching` decides what counts as a real answer; a result it rejects is
 * returned to the caller but never stored. A Redis blip on either side is
 * swallowed — a cache is an optimisation, and an unavailable one must degrade
 * to "call the provider", never to a failed tool call.
 */
export const withWebCache = async <T>(
  key: string,
  ttlSeconds: number,
  isWorthCaching: (value: T) => boolean,
  compute: () => Promise<T>,
): Promise<CachedEnvelope<T>> => {
  if (ttlSeconds <= 0) return { value: await compute(), cached: false };

  try {
    const hit = await redis.get(key);
    if (hit !== null) return { value: JSON.parse(hit) as T, cached: true };
  } catch {
    // Unreachable cache — fall through to the provider.
  }

  const value = await compute();

  if (isWorthCaching(value)) {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      // Failing to memoise must never fail the call that produced the value.
    }
  }

  return { value, cached: false };
};
