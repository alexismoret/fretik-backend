import { hostFromUrl, isUrlDenied } from "../web-egress";
import {
  effectiveSearchProvider,
  previewSources,
  searchFallbackProvider,
  type WebSearchProvider,
} from "./config";
import { WebProviderUnconfiguredError } from "./errors";
import type { PageMetadata } from "./page-meta";
import type {
  WebCallCost,
  WebImage,
  WebSearchOutcome,
  WebSearchRequest,
} from "./types";

/**
 * Search routing policy, kept apart from the adapters it drives.
 *
 * Separate file, and taking its adapters as an argument, because the policy is
 * the part with decisions in it — which provider serves a call, what counts as
 * a failure, which of the caller's filters the wire could not carry — while an
 * adapter is a translation. Injecting them also makes this testable without
 * module mocking, which in this suite is order-dependent by construction (see
 * `tests/lib/mock-module.ts`): a sibling file that imports the façade first
 * links the real adapters and no later mock can unbind them.
 */

export type SearchFn = (
  request: WebSearchRequest,
) => Promise<WebSearchOutcome & { cost: WebCallCost }>;

export type SearchAdapters = Record<WebSearchProvider, SearchFn>;

export interface RoutedSearch extends WebSearchOutcome {
  cost: WebCallCost;
  provider: WebSearchProvider;
}

/**
 * Drop results the deployment's domain policy would refuse to open, so the
 * model is never nudged toward a page it cannot read, and apply the caller's
 * exclusions the provider could not.
 *
 * That second job exists because Perplexity takes ONE domain list and refuses
 * an allowlist and a denylist in the same request. When a call carries both,
 * `exclude_domains` would be silently dropped on the wire — a filter the model
 * asked for and did not get is worse than one it was refused.
 */
export const filterHits = (
  outcome: WebSearchOutcome,
  excludeDomains: string[] | undefined,
  includeDomains: string[] | undefined,
): WebSearchOutcome => {
  const mustExclude =
    excludeDomains !== undefined &&
    excludeDomains.length > 0 &&
    includeDomains !== undefined &&
    includeDomains.length > 0
      ? excludeDomains.map((d) => d.replace(/^-/, "").toLowerCase())
      : [];

  return {
    results: outcome.results.filter((r) => {
      if (isUrlDenied(r.url)) return false;
      if (mustExclude.length === 0) return true;
      const host = hostFromUrl(r.url);
      if (host === null) return true;
      return !mustExclude.some((d) => host === d || host.endsWith(`.${d}`));
    }),
    images: outcome.images.filter((i) => !isUrlDenied(i.url)),
  };
};

/** Reads the `<head>` of each URL and returns what it found, keyed by URL. */
export type PreviewReader = (
  urls: string[],
) => Promise<Map<string, PageMetadata>>;

/**
 * Attach each top hit's own cover image and publisher, and collect the images
 * into a strip.
 *
 * **Why the pages and not a provider.** Neither search backend returns images,
 * and — measured 2026-09-12 — neither does the fetch backend: Parallel's
 * extract strips every `![](…)` out of the Markdown it produces, so the
 * previous design could not return a picture at any price. What a page always
 * has is its own `og:image`, the tag it publishes so that a link to it looks
 * right. Reading that keeps the affordance the old tool had (ask for images,
 * get images) and gives every picture a source the model can cite — which the
 * query-matched images of an image index never did.
 *
 * One image per hit rather than a page's whole illustration set: `og:image` is
 * the picture the publisher CHOSE for this page, so there is no site furniture
 * to tell apart from content and no heuristic to get wrong.
 *
 * It never fails the search. A blocked origin, a page with no card metadata, a
 * timeout — each costs that hit its picture and nothing else, because a
 * garnish that can sink the dish is worse than no garnish.
 */
export const attachPreviews = async (
  outcome: WebSearchOutcome,
  reader: PreviewReader,
  sources: number = previewSources(),
): Promise<WebSearchOutcome> => {
  const urls = outcome.results.slice(0, sources).map((r) => r.url);
  if (urls.length === 0) return outcome;

  let previews: Map<string, PageMetadata>;
  try {
    previews = await reader(urls);
  } catch {
    return outcome;
  }

  const results = outcome.results.map((hit) => {
    const meta = previews.get(hit.url);
    // A hit we could not read still gets a publisher: the host is what a card
    // would show anyway, and an always-present field is one the model can use
    // without first checking whether it is there.
    const siteName =
      meta?.siteName ?? hostFromUrl(hit.url)?.replace(/^www\./i, "");
    // `og:image` names a host of the page's choosing — usually a CDN, and
    // never one `filterHits` vetted. This runs AFTER that filter, so the
    // deployment's blocklist has to be applied again here or an image would
    // be the one way past it.
    const image =
      meta?.image == null || isUrlDenied(meta.image) ? null : meta.image;
    return {
      ...hit,
      ...(image === null ? {} : { image }),
      ...(siteName === undefined ? {} : { siteName }),
    };
  });

  /**
   * The strip drops a picture two hits share.
   *
   * Not deduplication for tidiness: an `og:image` that serves more than one
   * page is the SITE's default, not that page's illustration — measured,
   * cdiscount.com answers every product URL with its header logo. One
   * occurrence is indistinguishable from a real cover and is kept; a repeat
   * proves the picture says nothing about the page. The card keeps it either
   * way, because the publisher chose it to represent the link.
   */
  const seen = new Map<string, number>();
  for (const hit of results) {
    if (hit.image != null) seen.set(hit.image, (seen.get(hit.image) ?? 0) + 1);
  }

  const images: WebImage[] = results.flatMap((hit) =>
    hit.image == null || (seen.get(hit.image) ?? 0) > 1
      ? []
      : [
          {
            url: hit.image,
            ...(hit.title === null ? {} : { description: hit.title }),
          },
        ],
  );

  return { results, images };
};

/** Marker for "the provider answered, with nothing" — a failure the agent cannot distinguish from an error. */
const NO_RESULTS = "no results";

/**
 * Run the effective search provider, falling back to the other one when it
 * throws or answers nothing.
 *
 * Not a routing engine — one hop, one alternative. Search is the
 * highest-frequency tool and the one whose outage is most visible, and the
 * fallback is free to own because the second adapter is already written and
 * its key is already present for `webFetch`. Zero results counts as a failure
 * alongside an exception on purpose: a provider having a bad moment on one
 * phrasing looks identical to the agent either way.
 */
export const searchWithFallback = async (
  request: WebSearchRequest,
  adapters: SearchAdapters,
): Promise<RoutedSearch> => {
  const primary = effectiveSearchProvider();
  if (primary === null) {
    throw new WebProviderUnconfiguredError(
      "PERPLEXITY_API_KEY or PARALLEL_API_KEY",
    );
  }

  let primaryError: unknown;
  /**
   * What the primary billed before giving up.
   *
   * A search that comes back EMPTY is still a search the vendor charges for —
   * Perplexity bills per request, not per result — so reporting only the
   * fallback's cost would under-count every fallback by exactly one call, and
   * silently: the trace would look like one search because one search
   * succeeded. Known only on the empty path; a throw carries no usage.
   */
  let primarySpent = 0;
  try {
    const outcome = await adapters[primary](request);
    if (outcome.results.length > 0) return { ...outcome, provider: primary };
    primarySpent = outcome.cost.costUsd;
    primaryError = new Error(NO_RESULTS);
  } catch (err) {
    primaryError = err;
  }

  const fallback = searchFallbackProvider();
  if (fallback === null) {
    // An empty answer is a legitimate result to report; an exception is not
    // ours to swallow, so it reaches the tool's error envelope.
    if (primaryError instanceof Error && primaryError.message !== NO_RESULTS) {
      throw primaryError;
    }
    return {
      results: [],
      images: [],
      cost: { costUsd: 0, metadata: { provider: primary, empty: true } },
      provider: primary,
    };
  }

  const outcome = await adapters[fallback](request);
  return {
    ...outcome,
    provider: fallback,
    cost: {
      ...outcome.cost,
      costUsd: outcome.cost.costUsd + primarySpent,
      metadata: {
        ...outcome.cost.metadata,
        fallbackFrom: primary,
        ...(primarySpent > 0 ? { fallbackFromCostUsd: primarySpent } : {}),
        reason:
          primaryError instanceof Error ? primaryError.message : "unknown",
      },
    },
  };
};
