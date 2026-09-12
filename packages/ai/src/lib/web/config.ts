/**
 * Env resolution for the web research stack: which vendor serves which
 * capability, per-call deadlines, cache lifetimes, and the price table the
 * Langfuse cost trace is built from.
 *
 * Read on each call (cheap, and it lets a test flip an env var without
 * re-importing the module). Only the SDK clients are memoised, in the adapters.
 *
 * Capability map:
 *  - search → `AI_WEB_SEARCH_PROVIDER` (`perplexity` by default, `parallel` as
 *    the alternative AND the automatic fallback when the primary errors);
 *  - fetch  → Parallel `/v1/extract`, for its server-side headless browser;
 *  - map    → no vendor at all. `robots.txt` + `sitemap.xml` are published for
 *    robots to read, so discovery costs nothing and blocks nobody.
 */

export type WebSearchProvider = "perplexity" | "parallel";

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * The configured search backend. Anything other than an explicit `parallel`
 * resolves to Perplexity: a typo must not silently route traffic away from the
 * provider that measured first on both public benchmarks.
 */
export const webSearchProvider = (): WebSearchProvider =>
  process.env.AI_WEB_SEARCH_PROVIDER === "parallel" ? "parallel" : "perplexity";

export const perplexityApiKey = (): string | undefined =>
  process.env.PERPLEXITY_API_KEY || undefined;

export const parallelApiKey = (): string | undefined =>
  process.env.PARALLEL_API_KEY || undefined;

const providerKey = (provider: WebSearchProvider): string | undefined =>
  provider === "parallel" ? parallelApiKey() : perplexityApiKey();

const otherProvider = (provider: WebSearchProvider): WebSearchProvider =>
  provider === "perplexity" ? "parallel" : "perplexity";

/**
 * The search backend a call will actually reach: the configured one when its
 * key is present, otherwise whichever one IS keyed, otherwise `null`.
 *
 * The indirection is not pedantry. `PARALLEL_API_KEY` is already required for
 * `webFetch`, so the most likely partial setup is "Parallel key, no Perplexity
 * key yet" — and reading only the configured provider would prune `searchWeb`
 * from a deployment that can plainly search. Preference is still honoured
 * whenever it is satisfiable.
 */
export const effectiveSearchProvider = (): WebSearchProvider | null => {
  const preferred = webSearchProvider();
  if (providerKey(preferred) !== undefined) return preferred;
  const other = otherProvider(preferred);
  return providerKey(other) === undefined ? null : other;
};

/** True when some search backend is reachable. */
export const isSearchConfigured = (): boolean =>
  effectiveSearchProvider() !== null;

/** True when `webFetch` can run — it is Parallel-backed, whoever serves search. */
export const isFetchConfigured = (): boolean => parallelApiKey() !== undefined;

/**
 * The secondary search backend, or `null` when only one key is configured.
 *
 * Search is the highest-frequency tool and the one whose outage is most
 * visible, so it gets the one piece of routing this stack has. The fallback is
 * free to own: the other adapter is already written and its key is already
 * present for `webFetch`.
 */
export const searchFallbackProvider = (): WebSearchProvider | null => {
  if (process.env.AI_WEB_SEARCH_FALLBACK === "false") return null;
  const primary = effectiveSearchProvider();
  if (primary === null) return null;
  const other = otherProvider(primary);
  return providerKey(other) === undefined ? null : other;
};

/**
 * Per-call wall-clock deadlines (ms), sized on each operation's measured tail
 * rather than one global number. Perplexity answers a search in ~1 s and
 * Parallel's extract runs a headless browser per URL, so they cannot share one.
 */
export const timeouts = () => ({
  search: num(process.env.AI_WEB_SEARCH_TIMEOUT_MS, 20_000),
  fetch: num(process.env.AI_WEB_FETCH_TIMEOUT_MS, 30_000),
  map: num(process.env.AI_WEB_MAP_TIMEOUT_MS, 15_000),
});

/**
 * Cache lifetimes (seconds). Both OpenClaw and Hermes cache web results for
 * ~15 minutes, and the reason applies here twice over: an agent re-runs near
 * identical queries across steps, and a sub-agent dispatched on the same task
 * repeats its parent's. A hit costs nothing and returns instantly.
 *
 * Set either to `0` to disable that cache.
 */
export const cacheTtls = () => ({
  search: num(process.env.AI_WEB_SEARCH_CACHE_TTL_S, 900),
  fetch: num(process.env.AI_WEB_FETCH_CACHE_TTL_S, 900),
  map: num(process.env.AI_WEB_MAP_CACHE_TTL_S, 3_600),
});

/**
 * Context budgets, enforced provider-side so the compression happens before the
 * bytes cross the wire rather than after. Deliberately NOT model-facing
 * parameters: an agent asked to tune a character budget spends a reasoning step
 * on the one axis it cannot judge, and `maybePersistLargeOutput` already
 * catches the tail.
 */
export const budgets = () => ({
  /**
   * Per-result token cap for Perplexity, sent ONLY when an operator sets it.
   *
   * Unset by default on purpose. `search_context_size` is the provider's own
   * dial for how much content a result carries, its presets are what the
   * public benchmarks actually measured — medium scored 80 and posted the
   * board's lowest model-inference cost per task — and layering a hand-picked
   * cap on top both second-guesses that measurement and flattens our own
   * `depth` option, since a cap applied equally to `low` and `high` stops
   * `high` from returning any more than `low`. Left to the vendor unless an
   * operator has a reason.
   */
  searchTokensPerPage: num(process.env.AI_WEB_SEARCH_TOKENS_PER_PAGE, 0),
  /**
   * Result pages read to harvest images when a search asks for them. Each one
   * is an extract call ($0.001), so this is the price of the image strip and
   * it is only ever paid when the model sets `include_images`.
   */
  searchImageSources: num(process.env.AI_WEB_SEARCH_IMAGE_SOURCES, 3),
  fetchCharsPerResult: num(process.env.AI_WEB_FETCH_CHARS_PER_RESULT, 12_000),
  fetchCharsTotal: num(process.env.AI_WEB_FETCH_CHARS_TOTAL, 90_000),
  /** Parallel's per-result excerpt cap when it serves search. */
  searchCharsPerResult: num(process.env.AI_WEB_SEARCH_CHARS_PER_RESULT, 1_500),
  searchCharsTotal: num(process.env.AI_WEB_SEARCH_CHARS_TOTAL, 18_000),
});

/**
 * USD price table for the Langfuse cost trace. Public pay-as-you-go rates as of
 * 2026-09; every entry is env-overridable because a negotiated rate changes the
 * number without changing the code.
 *
 * Perplexity bills $5/1k requests flat — identical at every context size, and a
 * request carrying up to five queries counts once. Parallel bills per request
 * (mode-dependent), $1/1k for each result past the 10 included, and $1/1k URLs
 * on extract.
 */
export const prices = () => ({
  perplexitySearch: num(process.env.PERPLEXITY_PRICE_PER_SEARCH, 0.005),
  parallelSearchFast: num(process.env.PARALLEL_PRICE_PER_SEARCH_FAST, 0.001),
  parallelSearchDeep: num(process.env.PARALLEL_PRICE_PER_SEARCH_DEEP, 0.005),
  parallelExtraResult: num(process.env.PARALLEL_PRICE_PER_EXTRA_RESULT, 0.001),
  parallelExtractUrl: num(process.env.PARALLEL_PRICE_PER_EXTRACT_URL, 0.001),
});

/**
 * Template for the favicon URL attached to every hit, `{host}` replaced by the
 * result's hostname.
 *
 * No search API built for agents returns favicons — they return text — and
 * Tavily's, which did, were frequently `null`. So we derive them. The request
 * is issued by the USER'S browser when the `<img>` renders, never by this
 * service, which is why the operator lever matters: set
 * `AI_WEB_FAVICON_SERVICE=` (empty) to emit none and let the UI fall back to
 * its globe icon.
 */
export const faviconService = (): string | null => {
  const raw = process.env.AI_WEB_FAVICON_SERVICE;
  if (raw === undefined) return "https://icons.duckduckgo.com/ip3/{host}.ico";
  return raw === "" ? null : raw;
};

/**
 * User-Agent for the map crawler. Honest about who is asking — `robots.txt`
 * and `sitemap.xml` are published for robots, and a site that wants to refuse
 * one deserves to be able to recognise it.
 */
export const mapUserAgent = (): string =>
  process.env.AI_WEB_MAP_USER_AGENT ??
  "FretikBot/1.0 (+https://fretik.com/bot)";
