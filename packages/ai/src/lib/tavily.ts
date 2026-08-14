import type { TavilySearchOptions, TavilySearchResponse } from "@tavily/core";
import { tavily } from "@tavily/core";
import { traceExternalCall } from "./trace-tool";

type TavilyClient = ReturnType<typeof tavily>;

/**
 * Shared Tavily client — one instance per process, created lazily so a
 * deployment without `TAVILY_API_KEY` still boots (the web tools are
 * pruned from every registry by `pruneWebToolsIfUnavailable` in
 * `lib/web-egress.ts`, so the throw below is a defensive backstop).
 */
let client: TavilyClient | null | undefined;

export const getTavilyClient = (): TavilyClient | null => {
  if (client !== undefined) return client;
  const apiKey = process.env.TAVILY_API_KEY;
  client = apiKey ? tavily({ apiKey }) : null;
  return client;
};

export class TavilyUnconfiguredError extends Error {
  constructor() {
    super("Web tools are not configured on this deployment (TAVILY_API_KEY)");
    this.name = "TavilyUnconfiguredError";
  }
}

const requireTavilyClient = (): TavilyClient => {
  const c = getTavilyClient();
  if (c === null) throw new TavilyUnconfiguredError();
  return c;
};

/**
 * Per-call wall-clock timeouts, enforced twice:
 *  - a `Promise.race` against the deadline rejects with a typed
 *    `TavilyTimeoutError`, because the SDK throws a bare `Error` whose
 *    message we'd otherwise have to string-match. Tools catch it and
 *    surface a structured `{ error, code: "TAVILY_TIMEOUT" }` result to
 *    the model ("tools never throw on expected failures");
 *  - the SDK's native `timeout` option (seconds — `@tavily/core` forwards
 *    it to axios) actually aborts the HTTP request, a grace period LATER
 *    (see `NATIVE_TIMEOUT_GRACE_MS`).
 *
 * Defaults:
 *  - search : 10 s (measured p50 ≈ 1.7 s for a plain search)
 *  - search with images: 25 s — `includeImageDescriptions` runs a
 *    captioning pass server-side, which is 3× slower: measured p50 4.7 s,
 *    max 7.0 s over 6 fresh queries, and observed in prod blowing past
 *    10 s. A search that times out costs a full credit and a wasted
 *    round-trip, so this path gets a deadline sized on its own tail.
 *  - extract: 15 s (extract runs Tavily's full HTML → markdown pipeline)
 *  - map    : 15 s (site discovery crawls a page graph server-side)
 */
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_IMAGES_TIMEOUT_MS = 25_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 15_000;
const DEFAULT_MAP_TIMEOUT_MS = 15_000;

const resolveTimeoutMs = (envKey: string, fallback: number): number => {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const SEARCH_TIMEOUT_MS = resolveTimeoutMs(
  "AI_TAVILY_SEARCH_TIMEOUT_MS",
  DEFAULT_SEARCH_TIMEOUT_MS,
);
const SEARCH_IMAGES_TIMEOUT_MS = resolveTimeoutMs(
  "AI_TAVILY_SEARCH_IMAGES_TIMEOUT_MS",
  DEFAULT_SEARCH_IMAGES_TIMEOUT_MS,
);
const EXTRACT_TIMEOUT_MS = resolveTimeoutMs(
  "AI_TAVILY_EXTRACT_TIMEOUT_MS",
  DEFAULT_EXTRACT_TIMEOUT_MS,
);
const MAP_TIMEOUT_MS = resolveTimeoutMs(
  "AI_TAVILY_MAP_TIMEOUT_MS",
  DEFAULT_MAP_TIMEOUT_MS,
);

/**
 * The native abort must fire AFTER the typed race, never at the same
 * instant: the SDK's request timer starts when `.search()` is called —
 * one tick before `withTavilyTimeout` registers its own — so an equal
 * deadline is deterministically won by the SDK, and the model receives a
 * generic `WEB_SEARCH_ERROR` carrying a raw axios string instead of the
 * `TAVILY_TIMEOUT` this module exists to produce. Observed in prod
 * (2026-08-14): `"Web search failed: Request timed out after 10 seconds."`.
 */
const NATIVE_TIMEOUT_GRACE_MS = 2_000;

const toNativeTimeoutSeconds = (timeoutMs: number): number =>
  Math.max(1, Math.ceil((timeoutMs + NATIVE_TIMEOUT_GRACE_MS) / 1000));

export class TavilyTimeoutError extends Error {
  constructor(operation: "search" | "extract" | "map", timeoutMs: number) {
    super(`Tavily ${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "TavilyTimeoutError";
  }
}

/**
 * Race a Tavily promise against a timeout so the failure is typed. The
 * native SDK timeout (passed alongside) aborts the underlying request
 * within ~1 s of the same deadline, so no work keeps running (and no
 * credit keeps burning) behind a raced-out call.
 */
const withTavilyTimeout = async <T>(
  operation: "search" | "extract" | "map",
  timeoutMs: number,
  promise: Promise<T>,
): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new TavilyTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};

/**
 * Estimated price per Tavily credit (USD). Tavily bills in credits; the exact
 * rate depends on your plan, so it's env-overridable. Public pay-as-you-go
 * default ≈ $0.008/credit. Calls request `includeUsage`, so the traced cost
 * uses the ACTUAL billed credits when the API returns them; the local
 * formulas below are the fallback (search = 1 basic / 2 advanced; extract =
 * ⌈urls/5⌉ × depth factor; map = ⌈urls/10⌉ × 2 if instructions).
 */
const TAVILY_PRICE_PER_CREDIT = (() => {
  const raw = Number(process.env.TAVILY_PRICE_PER_CREDIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.008;
})();

const costFromUsage = (
  usage: { credits: number } | undefined,
  estimatedCredits: number,
): { costUsd: number; metadata: { credits: number; estimated: boolean } } => {
  const credits = usage?.credits ?? estimatedCredits;
  return {
    costUsd: credits * TAVILY_PRICE_PER_CREDIT,
    metadata: { credits, estimated: usage === undefined },
  };
};

/**
 * Timeout-wrapped shim around `tavilyClient.search`. Signature mirrors
 * the SDK method so call sites don't need extra Tavily types.
 */
export const searchTavily = async (
  query: string,
  options?: TavilySearchOptions,
): Promise<TavilySearchResponse> => {
  const estimatedCredits = options?.searchDepth === "advanced" ? 2 : 1;
  const timeoutMs =
    options?.includeImages === true
      ? SEARCH_IMAGES_TIMEOUT_MS
      : SEARCH_TIMEOUT_MS;
  return traceExternalCall(
    "web-search",
    { query },
    () =>
      withTavilyTimeout(
        "search",
        timeoutMs,
        requireTavilyClient().search(query, {
          ...options,
          includeUsage: true,
          timeout: toNativeTimeoutSeconds(timeoutMs),
        }),
      ),
    (r) => ({
      output: { results: Array.isArray(r.results) ? r.results.length : 0 },
      ...costFromUsage(r.usage, estimatedCredits),
    }),
  );
};

/**
 * Typed helper around Tavily's `/extract` endpoint. Given one or more
 * URLs, returns cleaned Markdown content + favicon + the source url.
 *
 * Used by the `webFetch` domain tool. Claude Code ships its own
 * `getURLMarkdownContent` helper that pulls HTML via axios and runs
 * turndown locally (~1.4MB retained heap for domino+turndown). Fretik
 * skips all of that and leans on Tavily because `/extract` already
 * returns Markdown, handles redirects, blocked domains, and paywall
 * detection server-side. One API key, zero HTML parsing dependency.
 *
 * With `query` (+ optional `chunksPerSource`), Tavily returns only the
 * passages most relevant to the query instead of the full page —
 * `content` then holds chunks joined by `[...]`.
 */
export interface ExtractedUrl {
  url: string;
  title: string | null;
  content: string;
  favicon: string | null;
}

export interface ExtractUrlsResult {
  results: ExtractedUrl[];
  failed: Array<{ url: string; error: string }>;
  responseTime: number;
}

export interface ExtractUrlsOptions {
  depth?: "basic" | "advanced";
  query?: string;
  chunksPerSource?: number;
}

export const extractUrls = async (
  urls: string[],
  options: ExtractUrlsOptions = {},
): Promise<ExtractUrlsResult> => {
  const depth = options.depth ?? "basic";
  // Tavily bills extract per group of 5 URLs; advanced costs 2× per group.
  const estimatedCredits =
    Math.ceil(urls.length / 5) * (depth === "advanced" ? 2 : 1);
  const response = await traceExternalCall(
    "web-fetch",
    { urls },
    () =>
      withTavilyTimeout(
        "extract",
        EXTRACT_TIMEOUT_MS,
        requireTavilyClient().extract(urls, {
          extractDepth: depth,
          format: "markdown",
          includeFavicon: true,
          includeUsage: true,
          timeout: toNativeTimeoutSeconds(EXTRACT_TIMEOUT_MS),
          ...(options.query === undefined
            ? {}
            : {
                query: options.query,
                chunksPerSource: options.chunksPerSource ?? 3,
              }),
        }),
      ),
    (r) => ({
      output: { results: r.results.length, failed: r.failedResults.length },
      ...costFromUsage(r.usage, estimatedCredits),
    }),
  );

  return {
    results: response.results.map((r) => ({
      url: r.url,
      title: r.title ?? null,
      content: r.rawContent,
      favicon: r.favicon ?? null,
    })),
    failed: response.failedResults.map((f) => ({
      url: f.url,
      error: f.error,
    })),
    responseTime: response.responseTime,
  };
};

/**
 * Typed helper around Tavily's `/map` endpoint — URL discovery on a
 * site, no content extraction. Used by the `webMap` domain tool to
 * find the right page before a targeted `webFetch`.
 */
export interface MapSiteOptions {
  instructions?: string;
  selectPaths?: string[];
  limit?: number;
}

export interface MapSiteResult {
  baseUrl: string;
  urls: string[];
  responseTime: number;
}

export const mapSite = async (
  url: string,
  options: MapSiteOptions = {},
): Promise<MapSiteResult> => {
  const limit = options.limit ?? 30;
  const response = await traceExternalCall(
    "web-map",
    { url, instructions: options.instructions },
    () =>
      withTavilyTimeout(
        "map",
        MAP_TIMEOUT_MS,
        requireTavilyClient().map(url, {
          limit,
          ...(options.instructions === undefined
            ? {}
            : { instructions: options.instructions }),
          ...(options.selectPaths === undefined
            ? {}
            : { selectPaths: options.selectPaths }),
          includeUsage: true,
          timeout: toNativeTimeoutSeconds(MAP_TIMEOUT_MS),
        }),
      ),
    (r) => ({
      output: { urls: r.results.length },
      // Map bills 1 credit per 10 discovered pages, ×2 with instructions.
      ...costFromUsage(
        r.usage,
        Math.max(1, Math.ceil(r.results.length / 10)) *
          (options.instructions === undefined ? 1 : 2),
      ),
    }),
  );

  return {
    baseUrl: response.baseUrl,
    urls: response.results,
    responseTime: response.responseTime,
  };
};
