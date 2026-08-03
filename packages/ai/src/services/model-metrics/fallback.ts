/**
 * Fallback intelligence + speed per profile key (chantier C8) — the safety
 * net used ONLY when Artificial Analysis is unreachable (no API key, network
 * error) or a model is unmatched in its response, so the picker always renders.
 * Live AA data overrides these whenever available. NOT gate facts — display
 * only. `costLevel` is never faked: it always comes from the real registry
 * price via `costLevelFromProfile`.
 *
 * Values captured from the AA v2 API on 2026-07-26, at the SAME effort level
 * each profile's `assessment.aaSlug` pins — a model rated at `xhigh` must not
 * fall back to its `low` figures. Two profiles have no AA throughput data
 * (`gpt-5.4-nano`, whose AA record carries intelligence but no tokens/second),
 * so their `speed` is a provider-class approximation.
 *
 * `timeToFirstAnswer` GAINED a fallback row on 2026-07-27. It was introduced as
 * garnish ("a stale number reads as authoritative in a way a blank does not"),
 * but it then became one of the three headline gauges on every card — so without
 * a fallback the whole Speed axis read "Not measured" for all 22 models whenever
 * AA was unreachable or `ARTIFICIAL_ANALYSIS_API_KEY` was unset, which is exactly
 * what happened on the first prod deploy. A day-old figure beats a blank column.
 *
 * The remaining richer axes (`toolUse`, `coding`, `instructionFollowing`,
 * `longContext`) keep no fallback: they live in the detail panel as secondary
 * evidence, where an honest "—" costs the reader nothing.
 */

export interface FallbackMetric {
  /** Approx Artificial Analysis Intelligence Index (~0-70 scale). */
  intelligence: number;
  /** Approx median output tokens/second. */
  speed: number;
  /**
   * Approx seconds to the first ANSWER token — what a user actually waits
   * through. Drives the Speed gauge on every card, hence a fallback.
   */
  timeToFirstAnswer: number;
}

export const FALLBACK_METRICS: Record<string, FallbackMetric> = {
  // Anthropic
  "claude-opus-5": { intelligence: 60.7, speed: 43.9, timeToFirstAnswer: 28.7 },
  "claude-sonnet-5": {
    intelligence: 53.4,
    speed: 83.4,
    timeToFirstAnswer: 108.4,
  },
  "claude-haiku-4.5": {
    intelligence: 29.6,
    speed: 150.2,
    timeToFirstAnswer: 15.7,
  },
  // OpenAI
  "gpt-5.6-sol": { intelligence: 55.9, speed: 65.8, timeToFirstAnswer: 11.3 },
  "gpt-5.6-terra": { intelligence: 49, speed: 114.6, timeToFirstAnswer: 2.4 },
  "gpt-5.6-luna": { intelligence: 49.1, speed: 161.2, timeToFirstAnswer: 36.1 },
  // AA reports 0 for BOTH throughput axes on the nano record, i.e. no data
  // rather than an instant model — provider-class estimates for both.
  "gpt-5.4-nano": { intelligence: 38.2, speed: 200, timeToFirstAnswer: 2 },
  "gpt-oss-120b": { intelligence: 23.8, speed: 275.7, timeToFirstAnswer: 7.8 },
  "gpt-oss-20b": { intelligence: 14.9, speed: 242.7, timeToFirstAnswer: 8.7 },
  // Google
  "gemini-3.1-pro": { intelligence: 46.5, speed: 132.2, timeToFirstAnswer: 31 },
  "gemini-3.6-flash": {
    intelligence: 50.1,
    speed: 219.4,
    timeToFirstAnswer: 14.5,
  },
  "gemini-3.5-flash-lite": {
    intelligence: 36.5,
    speed: 362.2,
    timeToFirstAnswer: 7.4,
  },
  "gemini-3.1-flash-lite": {
    intelligence: 25,
    speed: 298.6,
    timeToFirstAnswer: 5.6,
  },
  // Mistral
  "mistral-medium-3.5": {
    intelligence: 29.9,
    speed: 91.3,
    timeToFirstAnswer: 22.6,
  },
  "mistral-small-2603": {
    intelligence: 19.6,
    speed: 172.1,
    timeToFirstAnswer: 12.2,
  },
  "ministral-8b-2512": {
    intelligence: 9,
    speed: 119.8,
    timeToFirstAnswer: 0.7,
  },
  // MiniMax
  "minimax-m3": { intelligence: 44.4, speed: 86.6, timeToFirstAnswer: 24.3 },
  // DeepSeek
  "deepseek-v4-pro": {
    intelligence: 44.3,
    speed: 70.9,
    timeToFirstAnswer: 62.7,
  },
  // V4 Flash 0731. AA has scored its intelligence but NOT yet measured either
  // throughput axis — both come back as literal 0, i.e. "no data", not
  // "instant".
  //
  // Both figures were carried over from the April model (`-0420`) until
  // 2026-08-03, and that was WRONG in a user-visible way: 48.5s put the default
  // flagship in the "slow" bucket (>40s) while the eval gate measured it at
  // 30 846ms average turn latency against MiniMax M3's 56 325ms — nearly twice
  // as FAST as the model the card called "moderate". A number from a different
  // model, measured on a route we do not use, is not a conservative default.
  //
  // Replaced by figures grounded in our own routing (DeepInfra, pinned):
  // - `speed` 75 = the p50 throughput OpenRouter reports for that endpoint.
  // - `timeToFirstAnswer` 13.3 = AA's M3 figure (24.3s) scaled by the gate's
  //   measured latency ratio (30 846 / 56 325). Derived, not measured — but it
  //   agrees with two independent signals: a 1.96s TTFAT probe on an easy
  //   prompt, and `ttft + reasoning/throughput` from OpenRouter's p50s (13.2s).
  // Both are superseded at runtime the moment AA or OpenRouter reports real
  // numbers; this table only fires when BOTH sources are unreachable.
  "deepseek-v4-flash": {
    intelligence: 49.9,
    speed: 75,
    timeToFirstAnswer: 13.3,
  },
  // Z.ai
  "glm-5.2": { intelligence: 51.1, speed: 156.7, timeToFirstAnswer: 13.7 },
  // xAI
  "grok-4.5": { intelligence: 53.8, speed: 55.8, timeToFirstAnswer: 12.6 },
  // Thinking Machines
  inkling: { intelligence: 40.7, speed: 62.8, timeToFirstAnswer: 34.2 },
};
