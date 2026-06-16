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
  /** Median output tokens/second (Artificial Analysis). Null if unmatched. */
  speed: number | null;
  /**
   * Relative cost indicator 0-100 (higher = more expensive / more credits).
   * Log-scaled from the backend OpenRouter price — the dollar figure is never
   * exposed. Always present (price is always known from the registry catalog).
   */
  costLevel: number;
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
