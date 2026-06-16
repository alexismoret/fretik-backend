import type {
  CacheStrategy,
  ModelProfile,
} from "../../lib/model-registry/types";

/**
 * Backend-only price → relative cost abstraction (chantier C8).
 *
 * The raw dollar price NEVER leaves the backend. This maps the HAND-CURATED
 * registry price (`assessment.pricing`, USD/MTok — decoupled from OpenRouter,
 * fixed by hand) to a 0-100 `costLevel`: higher = more expensive / more
 * credits. A future credit system will bill off the same numbers, so the model
 * is honest about CACHING — both reads (cheaper) and writes (a premium).
 *
 * Cache model (approximate, one tunable table), aligned with OpenRouter's two
 * caching types. A typical mid-conversation turn splits its INPUT tokens into:
 *   - cache-read : the reused prefix (system prompt + history), priced at
 *     `cacheReadPerMTok` — the dominant, cost-lowering share (provider sticky
 *     routing maximises hits);
 *   - cache-write: new content written to the cache this turn. `implicit`
 *     caches (OpenAI/DeepSeek/Gemini 2.5) write for FREE; `explicit-breakpoints`
 *     (Anthropic) charge ~1.25× input (5-min TTL);
 *   - fresh      : whatever isn't cached, at full input price.
 * Output is never cached. The Anthropic "max 4 breakpoints" cap is a limit on
 * the NUMBER of cache markers, not on cached tokens — a large prefix still
 * caches fully, so it is NOT a cost factor (only `cache.strategy` is).
 *
 * A **log scale** is used because prices span orders of magnitude
 * ($0.05 → $80+ per MTok) — a linear map would crush every budget model to ~0.
 * Fixed bounds (not set-relative) keep a model's level stable regardless of
 * which models are shown together, so comparisons are always meaningful.
 */

interface CacheShares {
  /** Share of input tokens served from cache (read price). */
  read: number;
  /** Share of input tokens written to cache this turn (write price). */
  write: number;
  /** Cache-write price as a multiple of the input price. */
  writeMultiplier: number;
}

const CACHE_SHARES: Record<CacheStrategy, CacheShares> = {
  // Unlimited auto-cache: high reuse, writes are free.
  implicit: { read: 0.8, write: 0, writeMultiplier: 1 },
  // Breakpoint-limited (Anthropic): slightly lower reuse + 1.25× writes.
  "explicit-breakpoints": { read: 0.7, write: 0.1, writeMultiplier: 1.25 },
  // No caching: every input token pays full price.
  none: { read: 0, write: 0, writeMultiplier: 1 },
};

// Blended-price bounds ($/MTok, 3:1 input:output) spanning budget → frontier.
const COST_MIN_PER_MTOK = 0.05;
const COST_MAX_PER_MTOK = 80;
const LOG_MIN = Math.log10(COST_MIN_PER_MTOK);
const LOG_MAX = Math.log10(COST_MAX_PER_MTOK);

/** Per-turn input price after folding in cache reads (cheaper) + writes (premium). */
const effectiveInputPerMTok = (profile: ModelProfile): number => {
  const { inputPerMTok, cacheReadPerMTok } = profile.assessment.pricing;
  // No known cached rate → no cache modelling at all. Applying only a write
  // premium (no read discount) would unrealistically RAISE cost, so skip it.
  if (cacheReadPerMTok === undefined) return inputPerMTok;
  const shares = CACHE_SHARES[profile.assessment.cache.strategy];
  const freshShare = 1 - shares.read - shares.write;
  return (
    shares.read * cacheReadPerMTok +
    shares.write * shares.writeMultiplier * inputPerMTok +
    freshShare * inputPerMTok
  );
};

export const costLevelFromProfile = (profile: ModelProfile): number => {
  const effInput = effectiveInputPerMTok(profile);
  const blended = (effInput * 3 + profile.assessment.pricing.outputPerMTok) / 4;
  const clamped = Math.min(
    Math.max(blended, COST_MIN_PER_MTOK),
    COST_MAX_PER_MTOK,
  );
  const t = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return Math.round(t * 100);
};
