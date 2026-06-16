/**
 * Fallback intelligence + speed per profile key (chantier C8) — the safety
 * net used ONLY when Artificial Analysis is unreachable (no API key, network
 * error) or a model is unmatched in its response. Hand-curated approximations
 * (Artificial Analysis Intelligence Index + provider class) so the picker
 * always renders; live AA data overrides these whenever available. NOT gate
 * facts — display only. `costLevel` is never faked: it always comes from the
 * real catalog price via `costLevelFromProfile`.
 */

export interface FallbackMetric {
  /** Approx Artificial Analysis Intelligence Index (~0-70 scale). */
  intelligence: number;
  /** Approx median output tokens/second. */
  speed: number;
}

export const FALLBACK_METRICS: Record<string, FallbackMetric> = {
  "claude-opus-4.8": { intelligence: 55.7, speed: 67.785 },
  "claude-sonnet-4.6": { intelligence: 35.9, speed: 51.5 },
  "claude-haiku-4.5": { intelligence: 44, speed: 130 },
  "gpt-5.5": { intelligence: 54.8, speed: 69 },
  "gpt-5.4-nano": { intelligence: 38.2, speed: 156.901 },
  "gpt-oss-120b": { intelligence: 23.8, speed: 350.858 },
  "gpt-oss-20b": { intelligence: 14.9, speed: 241.996 },
  "gpt-4o-mini": { intelligence: 6.9, speed: 75.559 },
  "gemini-3.1-pro": { intelligence: 60, speed: 90 },
  "gemini-3.5-flash": { intelligence: 50.2, speed: 211.715 },
  "gemini-3.1-flash-lite": { intelligence: 25, speed: 306.346 },
  "mistral-medium-3.5": { intelligence: 29.9, speed: 141.393 },
  "mistral-small-2603": { intelligence: 4.7, speed: 157.875 },
  "ministral-8b-2512": { intelligence: 28, speed: 220 },
  "minimax-m3": { intelligence: 44.4, speed: 55.502 },
  "deepseek-v4-pro": { intelligence: 44.3, speed: 83.676 },
  "deepseek-v4-flash": { intelligence: 40.3, speed: 104.709 },
  "glm-5.1": { intelligence: 40.2, speed: 77.045 },
  "glm-4.7": { intelligence: 33.8, speed: 100.081 },
};
