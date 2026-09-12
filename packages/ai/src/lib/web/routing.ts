import { hostFromUrl, isUrlDenied } from "../web-egress";
import {
  budgets,
  effectiveSearchProvider,
  searchFallbackProvider,
  type WebSearchProvider,
} from "./config";
import { WebProviderUnconfiguredError } from "./errors";
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

/** Reads pages and returns the images found on them. */
export type ImageHarvester = (
  urls: string[],
) => Promise<{ results: { images?: WebImage[] }[] }>;

/**
 * Images for a search, read out of the pages the search itself returned.
 *
 * Search APIs built for agents return text, so the image strip has to be
 * harvested — and the only honest place to harvest it from is the sources the
 * answer is about to cite. That keeps the affordance the Tavily tool had (ask
 * for images, get images, without first choosing a page to open) while every
 * picture still belongs to a result the model can point at.
 *
 * Opt-in and priced: one extract per page read, paid only when the caller asks.
 * And it never fails the search — a provider error or a missing key costs the
 * strip, not the answer, because a garnish that can sink the dish is worse than
 * no garnish.
 */
export const harvestImages = async (
  results: readonly { url: string }[],
  harvester: ImageHarvester,
  sources: number = budgets().searchImageSources,
): Promise<WebImage[]> => {
  const urls = results.slice(0, sources).map((r) => r.url);
  if (urls.length === 0) return [];

  try {
    const fetched = await harvester(urls);
    return fetched.results.flatMap((page) => page.images ?? []);
  } catch {
    return [];
  }
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
  try {
    const outcome = await adapters[primary](request);
    if (outcome.results.length > 0) return { ...outcome, provider: primary };
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
      metadata: {
        ...outcome.cost.metadata,
        fallbackFrom: primary,
        reason:
          primaryError instanceof Error ? primaryError.message : "unknown",
      },
    },
  };
};
