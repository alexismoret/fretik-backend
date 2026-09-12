import { Perplexity } from "@perplexity-ai/perplexity_ai";
import { budgets, perplexityApiKey, prices, timeouts } from "./config";
import {
  nativeTimeoutMs,
  WebProviderUnconfiguredError,
  withWebTimeout,
} from "./errors";
import { faviconFor, normalizeDate } from "./normalize";
import type { WebCallCost, WebSearchOutcome, WebSearchRequest } from "./types";

/**
 * Perplexity adapter — `POST /search`.
 *
 * The default search backend since 2026-09, picked on two independent
 * provider-swap benchmarks that both hold the model and harness fixed:
 * Perplexity Search takes the TOP THREE places on the Artificial Analysis
 * Search Index (medium scores 80 against 75 for the previous leaders), and
 * leads OpenBenchmarks' search-only board at 77.3% where Tavily — the stack
 * this replaces — scores 47.3%. See `backend/docs/WEB-RESEARCH.md`.
 *
 * Three properties of the API shape the tool above it:
 *
 *  - **`query` takes a LIST.** Up to five phrasings ride one request, and a
 *    request is ONE billing unit however many queries it carries. The agent
 *    used to pay a full round-trip per reformulation; it now pays none.
 *  - **`search_context_size` costs the same at every level.** $5/1k flat for
 *    low, medium and high, so the depth dial is purely quality/latency/context
 *    and never an arbitration on price — which is why the tool can expose it
 *    without teaching the model a cost model.
 *  - **The filters are a superset of what the Tavily tool exposed.** Both date
 *    bounds, a relative recency preset, domain allow/deny, language, country,
 *    and the `academic` / `sec` verticals.
 *
 * What it does NOT have, and where each gap is answered: no URL fetch (that is
 * Parallel's `/v1/extract`, whose headless browser also reads JS-rendered
 * pages), no site map (`sitemap.ts`, free), no favicon (derived from the host),
 * no images (harvested from the Markdown of the pages `webFetch` reads).
 */

let client: Perplexity | null | undefined;

const requireClient = (): Perplexity => {
  if (client === undefined) {
    const apiKey = perplexityApiKey();
    client = apiKey === undefined ? null : new Perplexity({ apiKey });
  }
  if (client === null) {
    throw new WebProviderUnconfiguredError("PERPLEXITY_API_KEY");
  }
  return client;
};

/** Test seam — drops the memoised client so the next call re-reads env. */
export const resetPerplexityClient = (): void => {
  client = undefined;
};

/**
 * Our depth dial onto Perplexity's context sizes. All three cost $5/1k; they
 * differ in how much extracted content each result carries, which trades
 * against the tokens the agent then pays to read. `quick` led the independent
 * search-only board at the lowest token count, `medium` leads the AA index —
 * so the default sits at `standard` and the model moves it deliberately.
 */
const CONTEXT_SIZE = {
  quick: "low",
  standard: "medium",
  deep: "high",
} as const;

/**
 * Perplexity takes ONE domain list and reads a `-` prefix as exclusion; it
 * refuses an allowlist and a denylist in the same request. Include wins when
 * both are given — it is the stronger constraint, and the caller's exclusions
 * are then applied locally by the caller.
 */
const domainFilter = (
  include: string[] | undefined,
  exclude: string[] | undefined,
): string[] | undefined => {
  if (include !== undefined && include.length > 0) return include.slice(0, 20);
  if (exclude !== undefined && exclude.length > 0) {
    return exclude.slice(0, 20).map((d) => (d.startsWith("-") ? d : `-${d}`));
  }
  return undefined;
};

/**
 * A request is one billing unit whatever it carries — no per-query multiplier,
 * no per-result surcharge, no token fee. The rare price model that needs no
 * estimator.
 */
const searchCost = (request: WebSearchRequest): WebCallCost => ({
  costUsd: prices().perplexitySearch,
  metadata: {
    provider: "perplexity",
    depth: request.depth,
    queries: request.queries.length,
  },
});

export const perplexitySearch = async (
  request: WebSearchRequest,
): Promise<WebSearchOutcome & { cost: WebCallCost }> => {
  const timeoutMs = timeouts().search;
  const domains = domainFilter(request.includeDomains, request.excludeDomains);
  const singleQuery =
    request.queries.length === 1 ? request.queries[0] : undefined;

  const response = await withWebTimeout(
    "search",
    timeoutMs,
    requireClient().search.create(
      {
        // A single-element list would be sent as an array of one, which the API
        // accepts; passing the bare string keeps the wire shape conventional.
        query: singleQuery ?? request.queries,
        search_context_size: CONTEXT_SIZE[request.depth],
        max_tokens_per_page: budgets().searchTokensPerPage,
        ...(request.maxResults === undefined
          ? {}
          : { max_results: request.maxResults }),
        ...(domains === undefined ? {} : { search_domain_filter: domains }),
        ...(request.publishedAfter === undefined
          ? {}
          : { search_after_date_filter: request.publishedAfter }),
        ...(request.publishedBefore === undefined
          ? {}
          : { search_before_date_filter: request.publishedBefore }),
        ...(request.recency === undefined
          ? {}
          : { search_recency_filter: request.recency }),
        ...(request.mode === undefined ? {} : { search_mode: request.mode }),
        ...(request.languages === undefined
          ? {}
          : { search_language_filter: request.languages }),
        ...(request.country === undefined ? {} : { country: request.country }),
      },
      { timeout: nativeTimeoutMs(timeoutMs) },
    ),
  );

  return {
    results: response.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.snippet,
      favicon: faviconFor(r.url),
      // `date` is the publication date; `last_updated` is the crawl. Only the
      // former is a fact about the source, so it is the one that is shown.
      publishedDate: normalizeDate(r.date),
    })),
    images: [],
    cost: searchCost(request),
  };
};
