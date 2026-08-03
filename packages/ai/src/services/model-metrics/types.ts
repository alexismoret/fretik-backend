/**
 * Live, user-facing model metrics (chantier C8). Intelligence + speed come
 * from Artificial Analysis. Cost is a deliberate ABSTRACTION: the raw
 * OpenRouter dollar price stays backend-only and NEVER leaves this service —
 * the client only ever sees `costLevel`, a relative 0-100 cost indicator (a
 * future credit system will build on the same backend price). The level is a
 * log-scaled transform of the price (which spans orders of magnitude), so two
 * models with different prices always get different, comparable values — they
 * never collapse into one bucket. Everything here is DISPLAY only — it never
 * feeds resolution or the eval gate. Cached in Redis (stale-while-revalidate),
 * with a committed fallback so the picker always renders.
 */

export interface ModelMetrics {
  /** Artificial Analysis Intelligence Index (raw, ~0-70). Null if unmatched. */
  intelligence: number | null;
  /**
   * Median output tokens/second. Prefers OpenRouter's p50 for the upstream this
   * profile actually routes to (`fetch-openrouter-routing.ts`), falling back to
   * Artificial Analysis. OpenRouter wins because AA measures whichever route it
   * picked, which for a pinned profile is usually not ours — DeepSeek V4 Flash
   * runs on DeepInfra here, and AA never measured that endpoint at all. Null
   * when neither source has it.
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
   * Seconds to the first ANSWER token (AA `median_time_to_first_answer_token`).
   * The honest latency metric for a reasoning model: `speed` measures how fast
   * tokens flow once they start, and `median_time_to_first_token` fires on the
   * first REASONING token, so a model can score well on both while leaving the
   * user staring at nothing. Measured spread is enormous — 3.4s for GPT-5.6
   * Luna @medium, 252s for Kimi K3. Null if unmatched.
   */
  timeToFirstAnswer: number | null;
  /** AA Coding Index (raw). A second capability axis. Null if unmatched. */
  coding: number | null;
  /**
   * AA `tau_banking` (0-1) — multi-turn TOOL-USE reliability. The axis our
   * agent lives or dies on, and the one with the widest real spread between
   * otherwise similar models. Null if unmatched.
   */
  toolUse: number | null;
  /** AA `ifbench` (0-1) — instruction following. Null if unmatched. */
  instructionFollowing: number | null;
  /** AA `lcr` (0-1) — long-context reasoning. Null if unmatched. */
  longContext: number | null;
  /**
   * p50 seconds to the first token on the upstream we route to, measured by
   * OpenRouter over the last 30 minutes of live traffic.
   *
   * NOT interchangeable with `timeToFirstAnswer`: this fires on the first token
   * of ANY kind, so a model that reasons for a minute still scores ~1s here.
   * Kept as its own axis rather than folded into the Speed gauge — deriving
   * time-to-first-ANSWER from it (`ttft + reasoningTokens / throughput`) was
   * tried on 2026-08-03 and rejected: it ranked MiniMax M3 faster than DeepSeek
   * V4 Flash, while the eval gate measured the reverse by 1.8× end-to-end.
   * Null when OpenRouter has no sample for that endpoint.
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
