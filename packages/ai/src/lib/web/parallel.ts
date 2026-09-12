import { Parallel } from "parallel-web";
import type { SearchParams, UsageItem } from "parallel-web/resources/top-level";
import { budgets, parallelApiKey, prices, timeouts } from "./config";
import {
  nativeTimeoutMs,
  WebProviderUnconfiguredError,
  withWebTimeout,
} from "./errors";
import {
  applyPublishedBefore,
  faviconFor,
  imagesFromMarkdown,
  joinExcerpts,
  normalizeDate,
  recencyToAfterDate,
} from "./normalize";
import type {
  WebCallCost,
  WebFetchOutcome,
  WebFetchRequest,
  WebSearchOutcome,
  WebSearchRequest,
} from "./types";

/**
 * Parallel adapter — `/v1/extract` (the fetch backend) and `/v1/search` (the
 * search fallback).
 *
 * **Extract is why this vendor is here.** `webFetch` must read any page the
 * user points at, including one rendered client-side, and it must not do so
 * from our single datacenter IP — a hosted service fetching the open web from
 * one address collects blocks. Parallel runs a server-side headless browser
 * over its own egress, bills $1/1k URLs pay-as-you-go with no subscription, and
 * takes 20 URLs per call, so a batch of sources is one round-trip. Against the
 * Tavily `advanced` tier it replaces ($3.20/1k), it is 3.2× cheaper with the
 * browser always on rather than behind a `depth` flag the model kept forgetting
 * to pass.
 *
 * **Search is the fallback.** Perplexity leads both public benchmarks and
 * serves search by default, but it is the highest-frequency tool and its outage
 * is the most visible one. Since the key is already here for extract, a second
 * search backend costs nothing to own — the pattern Hermes' Web Search Plus
 * builds its whole value proposition on.
 */

let client: Parallel | null | undefined;

const requireClient = (): Parallel => {
  if (client === undefined) {
    const apiKey = parallelApiKey();
    client = apiKey === undefined ? null : new Parallel({ apiKey });
  }
  if (client === null) {
    throw new WebProviderUnconfiguredError("PARALLEL_API_KEY");
  }
  return client;
};

/** Test seam — drops the memoised client so the next call re-reads env. */
export const resetParallelClient = (): void => {
  client = undefined;
};

/**
 * Our depth dial onto Parallel's modes, used only on the fallback path.
 * Parallel also ships `basic` and `turbo` and both are dominated: `basic`
 * costs exactly what `advanced` costs ($5/1k) while scoring lower, and `turbo`
 * costs what `fast` costs ($1/1k) while scoring lower AND — because the agent
 * compensates with extra searches — measuring DEARER per completed task
 * ($13.64 vs $8.41/1k). Offering a dominated option to a model is offering it
 * a way to be wrong.
 */
const MODE: Record<
  WebSearchRequest["depth"],
  NonNullable<SearchParams["mode"]>
> = {
  quick: "fast",
  standard: "advanced",
  deep: "advanced",
};

/**
 * Live-fetch policy applied when the caller asked for fresh content. 600 s is
 * the API's floor for `max_age_seconds`. `disable_cache_fallback` stays false
 * so a slow origin degrades to cached content instead of failing the call.
 */
const FRESH_FETCH_POLICY = {
  max_age_seconds: 600,
  disable_cache_fallback: false,
} as const;

/** Images kept per fetched page, before the caller's own budget applies. */
const MAX_IMAGES_PER_PAGE = 6;

const searchCost = (
  usage: UsageItem[] | null | undefined,
  depth: WebSearchRequest["depth"],
  returned: number,
): WebCallCost => {
  const p = prices();
  const perRequest =
    MODE[depth] === "fast" ? p.parallelSearchFast : p.parallelSearchDeep;

  if (usage === null || usage === undefined || usage.length === 0) {
    // Fallback formula: one request at the mode's rate, plus $1/1k for each
    // result past the 10 that are included.
    const extras = Math.max(0, returned - 10);
    return {
      costUsd: perRequest + extras * p.parallelExtraResult,
      metadata: { provider: "parallel", depth, estimated: true },
    };
  }

  // SKU names are opaque and may change; anything not recognisably a "result"
  // SKU is billed as one request at the mode's rate.
  const costUsd = usage.reduce((total, item) => {
    const rate = /result/i.test(item.name) ? p.parallelExtraResult : perRequest;
    return total + rate * item.count;
  }, 0);

  return {
    costUsd,
    metadata: {
      provider: "parallel",
      depth,
      estimated: false,
      skus: usage.map((u) => `${u.name}×${u.count}`).join(", "),
    },
  };
};

export const parallelSearch = async (
  request: WebSearchRequest,
): Promise<WebSearchOutcome & { cost: WebCallCost }> => {
  const timeoutMs = timeouts().search;
  const b = budgets();

  // Parallel bounds a search from below only. `recency` collapses onto the same
  // bound, and the upper one is applied locally once results are back.
  const afterDate =
    request.publishedAfter ?? recencyToAfterDate(request.recency);

  const sourcePolicy = {
    ...(request.includeDomains === undefined
      ? {}
      : { include_domains: request.includeDomains }),
    ...(request.excludeDomains === undefined
      ? {}
      : { exclude_domains: request.excludeDomains }),
    ...(afterDate === undefined ? {} : { after_date: afterDate }),
  };

  const response = await withWebTimeout(
    "search",
    timeoutMs,
    requireClient().search(
      {
        search_queries: request.queries,
        mode: MODE[request.depth],
        max_chars_total: b.searchCharsTotal,
        advanced_settings: {
          excerpt_settings: { max_chars_per_result: b.searchCharsPerResult },
          ...(request.maxResults === undefined
            ? {}
            : { max_results: request.maxResults }),
          ...(request.country === undefined
            ? {}
            : { location: request.country }),
          ...(Object.keys(sourcePolicy).length === 0
            ? {}
            : { source_policy: sourcePolicy }),
        },
      },
      { timeout: nativeTimeoutMs(timeoutMs) },
    ),
  );

  const hits = response.results.map((r) => ({
    title: r.title ?? null,
    url: r.url,
    content: joinExcerpts(r.excerpts),
    favicon: faviconFor(r.url),
    publishedDate: normalizeDate(r.publish_date),
  }));

  return {
    results: applyPublishedBefore(hits, request.publishedBefore),
    images: [],
    cost: searchCost(response.usage, request.depth, response.results.length),
  };
};

const extractCost = (
  usage: UsageItem[] | null | undefined,
  urlCount: number,
): WebCallCost => {
  const rate = prices().parallelExtractUrl;
  if (usage === null || usage === undefined || usage.length === 0) {
    return {
      costUsd: urlCount * rate,
      metadata: { provider: "parallel", estimated: true, urls: urlCount },
    };
  }
  const billed = usage.reduce((n, u) => n + u.count, 0);
  return {
    costUsd: billed * rate,
    metadata: { provider: "parallel", estimated: false, billed },
  };
};

export const parallelFetch = async (
  request: WebFetchRequest,
): Promise<WebFetchOutcome & { cost: WebCallCost }> => {
  const timeoutMs = timeouts().fetch;
  const b = budgets();
  // Images live in the page body, which excerpts deliberately cut away — so
  // asking for images implies asking for the whole page.
  const wantsFullContent =
    request.fullContent === true || request.withImages === true;

  const response = await withWebTimeout(
    "fetch",
    timeoutMs,
    requireClient().extract(
      {
        urls: request.urls,
        max_chars_total: b.fetchCharsTotal,
        ...(request.objective === undefined
          ? {}
          : { objective: request.objective }),
        ...(request.queries === undefined
          ? {}
          : { search_queries: request.queries }),
        ...(request.sessionId === undefined
          ? {}
          : { session_id: request.sessionId }),
        advanced_settings: {
          excerpt_settings: { max_chars_per_result: b.fetchCharsPerResult },
          ...(wantsFullContent
            ? { full_content: { max_chars_per_result: b.fetchCharsPerResult } }
            : {}),
          ...(request.fresh === true
            ? { fetch_policy: FRESH_FETCH_POLICY }
            : {}),
        },
      },
      { timeout: nativeTimeoutMs(timeoutMs) },
    ),
  );

  return {
    results: response.results.map((r) => {
      // `full_content` is the whole page, `excerpts` the query-relevant
      // passages. Prefer whichever the caller asked for, but fall back to the
      // other rather than returning a blank row: a URL that answered at all is
      // worth more to the model than an empty page.
      const content = wantsFullContent
        ? (r.full_content ?? joinExcerpts(r.excerpts))
        : joinExcerpts(r.excerpts) || (r.full_content ?? "");

      const images =
        request.withImages === true
          ? imagesFromMarkdown(content, MAX_IMAGES_PER_PAGE)
          : [];

      return {
        url: r.url,
        title: r.title ?? null,
        content,
        favicon: faviconFor(r.url),
        publishedDate: normalizeDate(r.publish_date),
        ...(images.length > 0 ? { images } : {}),
      };
    }),
    failed: response.errors.map((e) => ({
      url: e.url,
      error: e.error_type,
      ...(e.http_status_code === null ? {} : { status: e.http_status_code }),
    })),
    cost: extractCost(response.usage, request.urls.length),
  };
};
