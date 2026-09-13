import { traceExternalCall } from "../trace-tool";
import { isUrlDenied } from "../web-egress";
import { webCacheKey, withWebCache } from "./cache";
import { cacheTtls, effectiveSearchProvider, previewSources } from "./config";
import { readPageMetadata, readPageMetadataBatch } from "./page-meta";
import { parallelFetch, parallelSearch } from "./parallel";
import { perplexitySearch } from "./perplexity";
import {
  attachPreviews,
  filterHits,
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
          // Unconditional, and that is the fix for a sequencing bug rather
          // than a preference. The model chose `include_images` while
          // SEARCHING, but only learns at WRITING time that its answer is a
          // list of places to go — by which point the data it would need is an
          // argument it did not pass ten seconds earlier. Traced on two
          // conversations: neither set it, and both had a section that wanted
          // cards. Reading previews costs no vendor money and ~0.9 s median
          // (measured +62 ms to +1.7 s), so the cheap side of the trade is
          // also the reliable one. `AI_WEB_PREVIEW_SOURCES=0` is the operator's
          // off switch, and the only one — a per-call flag is exactly what did
          // not work.
          const withPreviews = await attachPreviews(hits, (urls) =>
            readPageMetadataBatch(urls),
          );
          return { ...withPreviews, cost: routed.cost };
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
        async () => {
          const fetched = await parallelFetch(request);
          // Same source as a search's previews, for the same reason: the
          // Markdown the extract returns carries no images at all. One
          // `og:image` per page is what the publisher chose to represent it.
          //
          // Bounded by the same `AI_WEB_PREVIEW_SOURCES` as a search. At its
          // default of 20 that is every URL a `webFetch` can take, so the bound
          // binds nothing in practice and exists for the operator's off switch,
          // which is the only one left now that the tool exposes no per-call
          // flag. The reads run at `CONCURRENCY`, against a call that has
          // already spent tens of seconds in a headless browser per URL.
          const sources = previewSources();
          const previews = await readPageMetadataBatch(
            fetched.results.slice(0, sources).map((p) => p.url),
          );
          return {
            ...fetched,
            results: fetched.results.map((page) => {
              const image = previews.get(page.url)?.image;
              if (image === undefined || image === null) return page;
              return {
                ...page,
                images: [
                  {
                    url: image,
                    ...(page.title === null ? {} : { description: page.title }),
                  },
                ],
              };
            }),
          };
        },
        (r) => ({
          output: { results: r.results.length, failed: r.failed.length },
          costUsd: r.cost.costUsd,
          metadata: r.cost.metadata,
        }),
      ).then(({ cost: _cost, ...outcome }) => outcome),
  );

  return { ...value, cached };
};

export interface LinkPreview {
  /** Absolute http(s) cover image, or `null` — the page publishes none. */
  image: string | null;
  /** The publisher, `null` only when the page could not be read at all. */
  siteName: string | null;
}

export interface LinkPreviewResponse extends LinkPreview {
  cached: boolean;
}

/**
 * One page's card metadata, read on demand rather than harvested from a search.
 *
 * **Why a second door onto the same read.** A `:::link-card` is rendered from
 * the URL the MODEL wrote, and a search's previews are joined to it by that
 * URL — so a card only has a cover when the model retyped the address the
 * search returned. Measured in production, it frequently does not: asked for
 * ticket sites it cited `kayak.fr` where the hit was `kayak.fr/flights`, and it
 * named two sites no search had returned at all. The transcript now recovers
 * the first case on its own, but nothing in a tool output can answer the
 * second: the model cited a page this service never read. This is the read for
 * exactly that card.
 *
 * **Why it is cheap enough to offer.** No vendor bills it, the body stops at
 * `</head>`, and a transcript is re-rendered on every open — which is precisely
 * why the result is cached whatever it says. A page that publishes no picture
 * is the answer for hours, not an invitation to ask its origin again on the
 * next scroll.
 *
 * Deliberately untraced. It is not an AI call, it carries no cost, and it runs
 * outside any turn — so a Langfuse observation here would be an orphan root,
 * one per card, drowning the traces that do carry a cost.
 */
export const readLinkPreview = async (
  url: string,
): Promise<LinkPreviewResponse> => {
  const key = webCacheKey("link-preview", "page-meta", { url });

  const { value, cached } = await withWebCache(
    key,
    cacheTtls().preview,
    // Everything is worth caching here, a blank answer included — see above.
    () => true,
    async (): Promise<LinkPreview> => {
      // Never throws: a blocked, unreachable or non-HTML page resolves `null`,
      // and the egress guard rejects a private target the same way.
      const meta = await readPageMetadata(url);
      const image = meta?.image ?? null;
      return {
        // `og:image` names a host of the page's choosing — usually a CDN, and
        // never the one the URL itself was vetted against. Same second pass
        // `attachPreviews` makes, for the same reason: an image would
        // otherwise be the one way past the deployment's blocklist.
        image: image === null || isUrlDenied(image) ? null : image,
        siteName: meta?.siteName ?? null,
      };
    },
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
