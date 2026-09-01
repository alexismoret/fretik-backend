/**
 * Live, user-facing model metrics (chantier C8).
 *
 * Every figure is read from `model_live_state`, which the nightly sync
 * maintains: grades from Artificial Analysis, speed and latency from the
 * endpoint stats of the pool the model actually routes to, price from the pool
 * median. This service performs no upstream calls of its own (2026-08-30).
 *
 * Cost is a deliberate ABSTRACTION: the raw dollar price stays backend-only and
 * NEVER leaves this service — the client only ever sees `costLevel`, a relative
 * 0-100 cost indicator (a future credit system will build on the same backend
 * price). The level is a log-scaled transform of the price (which spans orders
 * of magnitude), so two models with different prices always get different,
 * comparable values — they never collapse into one bucket. Everything here is
 * DISPLAY only — it never feeds resolution or the eval gate. Cached in Redis
 * (stale-while-revalidate), with a committed fallback so the picker always
 * renders.
 */

export interface ModelMetrics {
  /** Artificial Analysis Intelligence Index (raw, ~0-70). Null if unmatched. */
  intelligence: number | null;
  /**
   * Median output tokens/second on the endpoint a turn is most likely to land
   * on — the fastest in the vetted pool, since every pool routes by throughput.
   *
   * Artificial Analysis is NOT a fallback for this: it times whichever route it
   * chose, which for a pinned pool is usually not one of ours — DeepSeek V4
   * Flash runs on DeepInfra here, and AA never measured that endpoint at all.
   * Falls back to the captured `FALLBACK_METRICS` figure, then null.
   */
  speed: number | null;
  /**
   * Relative cost indicator 0-100 (higher = more expensive / more credits).
   * Log-scaled from an estimated per-TURN cost that folds in the cached-input
   * rate and the model's measured verbosity — the dollar figure is never
   * exposed. Always present (price is always known from the registry).
   */
  costLevel: number;
  /**
   * This model's estimated per-turn cost as a multiple of the fleet's MEDIAN —
   * a multiple, never a price. `1` is a typical model, `0.3` is a third of
   * typical, `4` is four times it.
   *
   * Exists because `costLevel` is LOG-scaled and a ratio cannot be recovered
   * from it: two models three points apart may differ by 10 % or by 2×, and the
   * scale deliberately refuses to say which. A team comparing two candidates
   * asks exactly that question ("how much more does this one cost me"), and the
   * band label alone cannot answer it.
   *
   * ANCHORED ON THE MEDIAN, NOT THE CHEAPEST, because the cheapest is an
   * outlier and the anchor is what every figure in the fleet is divided by.
   * Measured 2026-08-31 over the 138 priced rows: the floor is a near-free
   * model, so against it the MEDIAN model reads "29.6× the cheapest" and the
   * dearest reads "2771×" — true, unusable, and indistinguishable from a bug.
   * Against the median the same fleet runs 0.03× to 94×, and the number carries
   * its own meaning: above one is dearer than usual, below one is cheaper.
   *
   * The dollar figure it derives from stays in this service — same invariant as
   * `costLevel`, and the same currency a future credit system would bill in.
   * `null` only when the fleet has no priced model at all.
   */
  costRatio: number | null;
  /**
   * Seconds to the first ANSWER token (AA `median_time_to_first_answer_token`).
   * The honest latency metric for a reasoning model: `speed` measures how fast
   * tokens flow once they start, and `median_time_to_first_token` fires on the
   * first REASONING token, so a model can score well on both while leaving the
   * user staring at nothing. Measured spread is enormous — 3.4s for GPT-5.6
   * Luna @medium, 252s for Kimi K3. Null if unmatched.
   */
  timeToFirstAnswer: number | null;
  /** AA Coding Index (raw, ~0-100). A second capability axis. Null if unmatched. */
  coding: number | null;
  /**
   * AA AGENTIC index (raw, ~0-100) — the axis our agent lives or dies on, and
   * the one with the widest real spread between otherwise similar models.
   *
   * Was AA's `tau_banking` (0-1) until 2026-08-30. That benchmark, along with
   * every other individual one, is Pro-only on the migrated API ($417/month,
   * declined); the composite agentic index replaced it and is measured across
   * a broader suite. The field name is unchanged deliberately — a rename would
   * ripple through the card contract and both locales for no gain — but the
   * SCALE did change, so anything comparing against a stored 0-1 threshold is
   * wrong. Null if unmatched.
   */
  toolUse: number | null;
  /**
   * p50 seconds to the first token on the endpoint a turn is most likely to
   * land on, measured over the last window the sync recorded.
   *
   * NOT interchangeable with `timeToFirstAnswer`: this fires on the first token
   * of ANY kind, so a model that reasons for a minute still scores ~1s here.
   * Kept as its own axis rather than folded into the Speed gauge — deriving
   * time-to-first-ANSWER from it (`ttft + reasoningTokens / throughput`) was
   * tried on 2026-08-03 and rejected: it ranked MiniMax M3 faster than DeepSeek
   * V4 Flash, while the eval gate measured the reverse by 1.8× end-to-end.
   * Null when no endpoint in the pool reports a latency.
   */
  ttftSeconds: number | null;
}

export interface ModelMetricsSnapshot {
  /** Metrics keyed by registry profile key. */
  metrics: Record<string, ModelMetrics>;
  /** ISO timestamp the snapshot was assembled. */
  fetchedAt: string;
  /** True when at least one source was unavailable and a fallback was used. */
  partial: boolean;
}

/** Attribution surfaced to the UI — Artificial Analysis requires it. */
export const METRICS_ATTRIBUTION = {
  intelligence: "artificial-analysis",
  speed: "artificial-analysis",
} as const;

export const ARTIFICIAL_ANALYSIS_URL =
  "https://artificialanalysis.ai/" as const;

/**
 * The page Artificial Analysis publishes for ONE model.
 *
 * The licence requires a link back wherever their figures are shown, and the
 * site root satisfies it — but a reader who clicks a credit under a specific
 * model's benchmarks is asking about THAT model, and landing on a homepage of
 * 400 others answers a question they did not ask. `slug` comes from AA's own
 * record, so it is their id for the model, not ours.
 */
export const artificialAnalysisModelUrl = (slug: string | undefined): string =>
  slug === undefined
    ? ARTIFICIAL_ANALYSIS_URL
    : `${ARTIFICIAL_ANALYSIS_URL}models/${slug}`;
