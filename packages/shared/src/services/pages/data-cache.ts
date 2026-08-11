import { redis } from "../../lib/redis";
import type { PageDataResponse } from "../../schemas/pages";
import { hashPageDataRequest } from "./public-cache";

/**
 * Cache for the AUTHENTICATED page data route.
 *
 * The public route has had one since it shipped; this closes the other half.
 * A dashboard left open on a wall re-asks the same question every time anyone
 * looks at it, and each ask is a handful of aggregates over a whole object
 * type — work that produced the same answer a moment ago.
 *
 * TWO DECISIONS, both deliberate:
 *
 * **A short TTL instead of event-driven invalidation.** Watching writes would
 * mean every record create, update, delete, import and workflow step knowing
 * which page keys they invalidate — a coupling that would reach the whole
 * codebase to buy at most 20 seconds of freshness. The cost of the TTL is
 * bounded and visible: a number can be up to 20 s stale, and the refresh button
 * bypasses it outright.
 *
 * **Singleflight in-process, not a Redis lock.** When a cached entry expires
 * under load, every concurrent request misses at once and they all run the same
 * queries — the stampede the cache existed to prevent. A promise map collapses
 * them per instance; the residue is at most one execution per replica, which is
 * not worth a distributed lock's failure modes (a held lock outliving a crashed
 * holder is a worse outage than one extra query).
 *
 * SCOPING: the key carries the TEAM and the definition's `updatedAt`. The team
 * because two teams reading the same shared page see their own records — a key
 * without it would serve one team's rows to another. The fingerprint because an
 * edited page must not read its predecessor's answer.
 */

/**
 * 20 s. With the client's own 30 s `staleTime`, a permanently-open dashboard
 * costs at most ~3 executions per minute per variable combination.
 */
export const PAGE_DATA_CACHE_TTL = 20;

/** In-flight executions, keyed exactly like the cache. */
const inFlight = new Map<string, Promise<PageDataResponse>>();

export const pageDataCacheKey = (input: {
  pageId: string;
  teamId: string;
  /** The definition's `updatedAt` — editing a page retires its entries. */
  definitionFingerprint: string;
  request: {
    variables: Record<string, unknown>;
    datasetIds?: string[];
    queries?: Record<string, unknown>;
  };
}): string =>
  `page:data:${input.pageId}:${input.teamId}:${input.definitionFingerprint}:${hashPageDataRequest(input.request)}`;

/**
 * Serve a page's datasets from cache, or run them once and share that run.
 *
 * `fresh` bypasses the read but still populates — it backs the refresh button,
 * whose whole meaning is "ignore what you were told before". It is honoured on
 * this route ONLY: on the published route it would hand any anonymous visitor a
 * switch to disable the cache in front of the owner's database.
 *
 * A failed execution is never cached, and never left in the in-flight map.
 */
export const cachedPageData = async (input: {
  key: string;
  fresh?: boolean;
  run: () => Promise<PageDataResponse>;
}): Promise<PageDataResponse> => {
  if (!input.fresh) {
    const cached = await redis.get(input.key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as PageDataResponse;
      } catch {
        // A malformed entry is a cache problem, not a request problem — fall
        // through and recompute rather than failing the page.
      }
    }
    // Joining an execution already under way is the point: without this, an
    // expiring entry costs one full run PER concurrent reader.
    const running = inFlight.get(input.key);
    if (running) return await running;
  }

  const execution = input.run();
  inFlight.set(input.key, execution);
  try {
    const response = await execution;
    await redis.set(
      input.key,
      JSON.stringify(response),
      "EX",
      PAGE_DATA_CACHE_TTL,
    );
    return response;
  } finally {
    inFlight.delete(input.key);
  }
};
