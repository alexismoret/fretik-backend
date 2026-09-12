import { traceExternalCall } from "../trace-tool";
import { isUrlDenied } from "../web-egress";
import { webCacheKey, withWebCache } from "./cache";
import { cacheTtls, effectiveSearchProvider } from "./config";
import { parallelFetch, parallelSearch } from "./parallel";
import { perplexitySearch } from "./perplexity";
import {
  filterHits,
  harvestImages,
  searchWithFallback,
  type SearchAdapters,
} from "./routing";
import { mapSiteFromSitemap } from "./sitemap";
import type {
  WebFetchOutcome,
  WebFetchRequest,
  WebMapOutcome,
  WebMapRequest,
  WebSearchOutcome,
  WebSearchRequest,
} from "./types";

/**
 * The façade the tools call: routing, caching, egress filtering and cost
 * tracing composed in one place, so each tool file stays about its own schema
 * and error envelope.
 *
 * Capability map, and why each sits where it does:
 *
 *  - **search** → Perplexity by default (first on both independent
 *    provider-swap benchmarks), Parallel as the alternative and the automatic
 *    fallback;
 *  - **fetch** → Parallel, for a server-side headless browser on someone
 *    else's egress: `webFetch` must read JS-rendered pages, and a hosted
 *    service reading the open web from one datacenter IP collects blocks;
 *  - **map** → nobody. `robots.txt` and `sitemap.xml` are published for robots.
 */

export {
  WebProviderUnconfiguredError,
  WebTimeoutError,
  type WebOperation,
} from "./errors";
export type { WebFetchOutcome, WebMapOutcome, WebSearchOutcome };

const SEARCH_ADAPTERS: SearchAdapters = {
  perplexity: perplexitySearch,
  parallel: parallelSearch,
};

export interface WebSearchResponse extends WebSearchOutcome {
  cached: boolean;
}

export const searchWeb = async (
  request: WebSearchRequest,
): Promise<WebSearchResponse> => {
  // Keyed on the provider that will serve it: two backends rank differently,
  // so a cached Parallel answer must not be replayed for a Perplexity search.
  const key = webCacheKey(
    "search",
    effectiveSearchProvider() ?? "none",
    request,
  );

  const { value, cached } = await withWebCache(
    key,
    cacheTtls().search,
    (outcome: WebSearchOutcome) => outcome.results.length > 0,
    async () =>
      traceExternalCall(
        "web-search",
        { queries: request.queries, depth: request.depth },
        async () => {
          const routed = await searchWithFallback(request, SEARCH_ADAPTERS);
          const hits = filterHits(
            routed,
            request.excludeDomains,
            request.includeDomains,
          );
          return {
            ...hits,
            images:
              request.includeImages === true
                ? await harvestImages(hits.results, (urls) =>
                    parallelFetch({
                      urls,
                      withImages: true,
                      fullContent: true,
                    }),
                  )
                : hits.images,
            cost: routed.cost,
          };
        },
        (r) => ({
          output: { results: r.results.length },
          costUsd: r.cost.costUsd,
          metadata: r.cost.metadata,
        }),
      ).then(({ cost: _cost, ...outcome }) => outcome),
  );

  return { ...value, cached };
};

export interface WebFetchResponse extends WebFetchOutcome {
  cached: boolean;
}

export const fetchPages = async (
  request: WebFetchRequest,
): Promise<WebFetchResponse> => {
  const key = webCacheKey("fetch", "parallel", request);

  const { value, cached } = await withWebCache(
    key,
    cacheTtls().fetch,
    (outcome: WebFetchOutcome) => outcome.results.length > 0,
    async () =>
      traceExternalCall(
        "web-fetch",
        { urls: request.urls },
        () => parallelFetch(request),
        (r) => ({
          output: { results: r.results.length, failed: r.failed.length },
          costUsd: r.cost.costUsd,
          metadata: r.cost.metadata,
        }),
      ).then(({ cost: _cost, ...outcome }) => outcome),
  );

  return { ...value, cached };
};

export interface WebMapResponse extends WebMapOutcome {
  cached: boolean;
}

export const mapSite = async (
  request: WebMapRequest,
): Promise<WebMapResponse> => {
  const key = webCacheKey("map", "sitemap", request);

  const { value, cached } = await withWebCache(
    key,
    cacheTtls().map,
    (outcome: WebMapOutcome) => outcome.links.length > 0,
    async () =>
      traceExternalCall(
        "web-map",
        { url: request.url, search: request.search },
        async () => {
          const outcome = await mapSiteFromSitemap(request);
          return {
            ...outcome,
            links: outcome.links.filter((l) => !isUrlDenied(l.url)),
          };
        },
        // No cost line: discovery runs on `robots.txt` and `sitemap.xml`, so
        // there is no vendor to bill it. The observation still records that the
        // call happened, and how much it found.
        (r) => ({ output: { links: r.links.length } }),
      ),
  );

  return { ...value, cached };
};
