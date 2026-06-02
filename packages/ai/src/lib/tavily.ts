import { tavily } from "@tavily/core";
import { traceExternalCall } from "./trace-tool";

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) {
  throw "Missing TAVILY_API_KEY env";
}

/** Shared Tavily client — one instance per process, reused by every tool. */
export const tavilyClient = tavily({ apiKey });

/**
 * Per-call wall-clock timeouts. `@tavily/core@0.7.2` does not accept
 * an `AbortSignal` nor a native `timeout` option, so we wrap every
 * call in `Promise.race` against a `setTimeout` that rejects with a
 * `TavilyTimeoutError`. Tools catch it and surface a structured
 * `{ error, code: "TAVILY_TIMEOUT" }` result to the model, matching
 * the "tools never throw on expected failures" pattern.
 *
 * Defaults:
 *  - search : 10 s (search returns a small JSON, usually <1 s)
 *  - extract: 15 s (extract runs Tavily's full HTML → markdown pipeline)
 */
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 15_000;

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
const EXTRACT_TIMEOUT_MS = resolveTimeoutMs(
  "AI_TAVILY_EXTRACT_TIMEOUT_MS",
  DEFAULT_EXTRACT_TIMEOUT_MS,
);

export class TavilyTimeoutError extends Error {
  constructor(operation: "search" | "extract", timeoutMs: number) {
    super(`Tavily ${operation} exceeded ${timeoutMs}ms timeout`);
    this.name = "TavilyTimeoutError";
  }
}

/**
 * Race a Tavily promise against a timeout. On timeout, rejects with
 * `TavilyTimeoutError`; the Tavily call is NOT cancelled (the SDK
 * doesn't support cancellation) — it will resolve in the background
 * and its result is discarded. The wasted work is negligible vs. the
 * cost of a stuck tool call blocking the agent's step budget.
 */
const withTavilyTimeout = async <T>(
  operation: "search" | "extract",
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
 * default ≈ $0.008/credit. Credits per call: search = 1 (basic) / 2
 * (advanced); extract = ⌈urls/5⌉ × (1 basic / 2 advanced).
 */
const TAVILY_PRICE_PER_CREDIT = (() => {
  const raw = Number(process.env.TAVILY_PRICE_PER_CREDIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.008;
})();

/**
 * Typed helper around Tavily's `/extract` endpoint. Given one or more
 * URLs, returns cleaned Markdown content + favicon + the source url.
 *
 * Used by the `webFetch` domain tool (Phase 5). Claude Code ships its
 * own `getURLMarkdownContent` helper that pulls HTML via axios and
 * runs turndown locally (~1.4MB retained heap for domino+turndown).
 * Fretik skips all of that and leans on Tavily because `/extract`
 * already returns Markdown, handles redirects, blocked domains, and
 * paywall detection server-side. One API key, zero HTML parsing
 * dependency. See `keyDecisions.webFetch` in the overhaul progress.
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

/**
 * Timeout-wrapped shim around `tavilyClient.search`. Signature and
 * return type are inferred from the SDK method itself so call sites
 * don't need to import any extra Tavily types.
 */
export const searchTavily: typeof tavilyClient.search = async (
  query,
  options,
) => {
  const credits = options?.searchDepth === "advanced" ? 2 : 1;
  return traceExternalCall(
    "web-search",
    { query },
    () =>
      withTavilyTimeout(
        "search",
        SEARCH_TIMEOUT_MS,
        tavilyClient.search(query, options),
      ),
    (r) => ({
      output: { results: Array.isArray(r.results) ? r.results.length : 0 },
      costUsd: credits * TAVILY_PRICE_PER_CREDIT,
      metadata: { credits },
    }),
  );
};

export const extractUrls = async (
  urls: string[],
  depth: "basic" | "advanced" = "basic",
): Promise<ExtractUrlsResult> => {
  // Tavily bills extract per group of 5 URLs; advanced costs 2× per group.
  const credits = Math.ceil(urls.length / 5) * (depth === "advanced" ? 2 : 1);
  const response = await traceExternalCall(
    "web-fetch",
    { urls },
    () =>
      withTavilyTimeout(
        "extract",
        EXTRACT_TIMEOUT_MS,
        tavilyClient.extract(urls, {
          extractDepth: depth,
          format: "markdown",
          includeFavicon: true,
        }),
      ),
    (r) => ({
      output: { results: r.results.length, failed: r.failedResults.length },
      costUsd: credits * TAVILY_PRICE_PER_CREDIT,
      metadata: { credits },
    }),
  );

  return {
    results: response.results.map((r) => ({
      url: r.url,
      title: r.title ?? null,
      content: r.rawContent,
      favicon: (r as { favicon?: string }).favicon ?? null,
    })),
    failed: response.failedResults.map((f) => ({
      url: f.url,
      error: f.error,
    })),
    responseTime: response.responseTime,
  };
};
