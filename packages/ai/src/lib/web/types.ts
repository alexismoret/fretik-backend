/**
 * Provider-neutral DTOs for the web research stack.
 *
 * Every web tool (`searchWeb`, `webFetch`, `webMap`) speaks these shapes; the
 * adapters under `lib/web/` translate them to and from whichever vendor is
 * configured. Two reasons this seam exists rather than tools calling an SDK
 * directly, as they did in the Tavily era:
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
   * post-Tavily stack: the agent used to fire one `searchWeb` per phrasing and
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
  /** Relative freshness window; translated to each provider's native filter. */
  recency?: "hour" | "day" | "week" | "month" | "year";
  /** Search vertical. `academic` for research/standards, `sec` for filings. */
  mode?: "web" | "academic" | "sec";
  /** ISO 639-1 codes restricting the language of the sources. */
  languages?: string[];
  /** ISO 3166-1 alpha-2, for geo-targeted results. */
  country?: string;
  /**
   * Also return images, harvested from the top hits. Costs one extract per
   * page read, so it is opt-in and never implied.
   */
  includeImages?: boolean;
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
  /** Harvest the page's images (off by default — most fetches want text). */
  withImages?: boolean;
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
