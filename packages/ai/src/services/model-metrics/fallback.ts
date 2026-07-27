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
 * The richer axes added in 2026-07 (`toolUse`, `coding`, `timeToFirstAnswer`, …)
 * deliberately have NO fallback rows: they are display garnish, and a stale
 * committed number reads as authoritative in a way a blank does not.
 */

export interface FallbackMetric {
  /** Approx Artificial Analysis Intelligence Index (~0-70 scale). */
  intelligence: number;
  /** Approx median output tokens/second. */
  speed: number;
}

export const FALLBACK_METRICS: Record<string, FallbackMetric> = {
  // Anthropic
  "claude-opus-5": { intelligence: 60.7, speed: 43.9 },
  "claude-sonnet-5": { intelligence: 53.4, speed: 83.4 },
  "claude-haiku-4.5": { intelligence: 29.6, speed: 150.2 },
  // OpenAI
  "gpt-5.6-sol": { intelligence: 55.9, speed: 65.8 },
  "gpt-5.6-terra": { intelligence: 49, speed: 114.6 },
  "gpt-5.6-luna": { intelligence: 49.1, speed: 161.2 },
  // AA reports no tokens/second for the nano record — provider-class estimate.
  "gpt-5.4-nano": { intelligence: 38.2, speed: 200 },
  "gpt-oss-120b": { intelligence: 23.8, speed: 275.7 },
  "gpt-oss-20b": { intelligence: 14.9, speed: 242.7 },
  // Google
  "gemini-3.1-pro": { intelligence: 46.5, speed: 132.2 },
  "gemini-3.6-flash": { intelligence: 50.1, speed: 219.4 },
  "gemini-3.5-flash-lite": { intelligence: 36.5, speed: 362.2 },
  "gemini-3.1-flash-lite": { intelligence: 25, speed: 298.6 },
  // Mistral
  "mistral-medium-3.5": { intelligence: 29.9, speed: 91.3 },
  "mistral-small-2603": { intelligence: 19.6, speed: 172.1 },
  "ministral-8b-2512": { intelligence: 9, speed: 119.8 },
  // MiniMax
  "minimax-m3": { intelligence: 44.4, speed: 86.6 },
  // DeepSeek
  "deepseek-v4-pro": { intelligence: 44.3, speed: 70.9 },
  "deepseek-v4-flash": { intelligence: 40.3, speed: 117.7 },
  // Z.ai
  "glm-5.2": { intelligence: 51.1, speed: 156.7 },
  // xAI
  "grok-4.5": { intelligence: 53.8, speed: 55.8 },
  // Thinking Machines
  inkling: { intelligence: 40.7, speed: 62.8 },
};
