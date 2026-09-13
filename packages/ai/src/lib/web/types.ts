/**
 * Provider-neutral DTOs for the web research stack.
 *
 * Every web tool (`searchWeb`, `webFetch`, `webMap`) speaks these shapes; the
 * adapters under `lib/web/` translate them to and from whichever vendor is
 * configured. Two reasons this seam exists rather than tools calling an SDK
 * directly, as they did before the 2026-09 provider swap:
 *
 *  1. **The output contract is the UI contract.** A tool result is rendered by
 *     `<ChatbotToolsToolWebSearch>` and replayed forever out of stored
 *     conversations. Pinning the shape here means swapping a vendor never
 *     reaches the frontend or invalidates history.
 *  2. **A provider swap must be one env var.** `AI_WEB_SEARCH_PROVIDER` picks
 *     the search backend, so a regression rolls back without a deploy — and the
 *     same switch lets the Langfuse eval loop score two providers over our own
 *     gold set instead of us trusting a public benchmark.
 */

/** One hit from a web search. Mirrors what the frontend row renders. */
export interface WebSearchHit {
  title: string | null;
  url: string;
  /**
   * The source's own words about itself: a snippet (Perplexity) or the ranked
   * passages a retrieval API extracted (Parallel), joined by the adapter.
   */
  content: string;
  favicon: string | null;
  /** Only when the source exposes one. */
  publishedDate: string | null;
  /**
   * When the search index last CRAWLED the page — not when the page was
   * written.
   *
   * Load-bearing, and it was dropped until 2026-09-12 on the reasoning that
   * only a publication date is "a fact about the source". That reasoning
   * failed on exactly the class of page where it matters most. Traced on a
   * real conversation: an apple.com product page last crawled 2026-07-21 came
   * back quoting 2 999 €, a retailer crawled 2026-09-10 quoted 3 559 € for the
   * same configuration, and BOTH arrived carrying `publishedDate: null`
   * because a shop page publishes no date. The agent saw the contradiction,
   * doubted itself four times in its reasoning, and settled it on domain
   * authority — the only signal left to it. A price, a stock level or an
   * opening time is a fact about the CRAWL, so the crawl date travels.
   */
  lastCrawled: string | null;
  /**
   * The page's own cover image (`og:image`), attached when the caller asked
   * for previews. Best-effort: absent for a site that refuses our read.
   */
  image?: string | null;
  /** The publisher's name for a link card, e.g. "MacGeneration". */
  siteName?: string | null;
}

/** An image returned alongside hits when the caller asked for them. */
export interface WebImage {
  url: string;
  description?: string;
}

export interface WebSearchOutcome {
  results: WebSearchHit[];
  images: WebImage[];
}

export interface WebSearchRequest {
  /**
   * 1-5 keyword queries. Multi-query is the headline capability of the
   * current stack: the agent used to fire one `searchWeb` per phrasing and
   * pay a full round-trip each time. Perplexity bills a request carrying up to
   * five queries as ONE unit, so every phrasing now rides a single call.
   */
  queries: string[];
  /**
   * How much extracted content each result carries. Costs the same at every
   * level on Perplexity, so this is a quality/latency/context dial and never a
   * price one.
   */
  depth: "quick" | "standard" | "deep";
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** ISO `YYYY-MM-DD`, inclusive. */
  publishedAfter?: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  publishedBefore?: string;
  /**
   * Only results the index has CRAWLED since this date (ISO `YYYY-MM-DD`).
   *
   * Distinct from `publishedAfter`, and the one that answers a volatile
   * question: a shop page carries no publication date at all, so bounding on
   * publication silently drops it while bounding on the crawl keeps it and
   * drops the stale snapshot instead.
   */
  crawledAfter?: string;
  /** Relative freshness window; translated to each provider's native filter. */
  recency?: "hour" | "day" | "week" | "month" | "year";
  /** Search vertical. `academic` for research/standards, `sec` for filings. */
  mode?: "web" | "academic" | "sec";
  /** ISO 639-1 codes restricting the language of the sources. */
  languages?: string[];
  /** ISO 3166-1 alpha-2, for geo-targeted results. */
  country?: string;
}

/**
 * One page returned by a fetch. `content` is Markdown.
 *
 * There is deliberately no `finalUrl`: OpenClaw's local fetch reports one
 * because it follows the redirects itself, and Parallel's extract does not
 * expose the distinction between the URL requested and the one it landed on.
 * A field that never populates is worse than an absent one — the model would
 * learn to ignore it.
 */
export interface FetchedPage {
  url: string;
  title: string | null;
  content: string;
  favicon: string | null;
  publishedDate: string | null;
  /** Images found in the page, for the agent to render in a `::gallery`. */
  images?: WebImage[];
}

export interface FetchFailure {
  url: string;
  error: string;
  /** HTTP status when the provider reported one — 403 and 404 differ. */
  status?: number;
}

export interface WebFetchOutcome {
  results: FetchedPage[];
  failed: FetchFailure[];
}

export interface WebFetchRequest {
  urls: string[];
  /** Focus the excerpts on this goal instead of returning the page whole. */
  objective?: string;
  queries?: string[];
  /** Return the full page Markdown rather than query-relevant excerpts. */
  fullContent?: boolean;
  /** Bypass the provider's content cache and fetch live. */
  fresh?: boolean;
  /** Correlates the calls of one agent task for better contextual ranking. */
  sessionId?: string;
}

/** One URL discovered on a site, with whatever metadata the source exposed. */
export interface SiteLink {
  url: string;
  title: string | null;
}

export interface WebMapOutcome {
  baseUrl: string;
  links: SiteLink[];
}

export interface WebMapRequest {
  url: string;
  /** Case-insensitive substring filter over the URL and its title. */
  search?: string;
  /** Regex filters applied to the URL path. */
  selectPaths?: string[];
  limit?: number;
}

/** What an adapter reports back so the caller can price the Langfuse trace. */
export interface WebCallCost {
  costUsd: number;
  metadata: Record<string, unknown>;
}
