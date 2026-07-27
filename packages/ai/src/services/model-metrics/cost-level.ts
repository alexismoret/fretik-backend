import type { ModelProfile } from "../../lib/model-registry/types";

/**
 * Backend-only price → relative cost abstraction (chantier C8).
 *
 * The raw dollar price NEVER leaves the backend. This maps the HAND-CURATED
 * registry price (`assessment.pricing`, USD/MTok) to a 0-100 `costLevel`:
 * higher = more expensive / more credits. A future credit system will bill off
 * the same numbers.
 *
 * # Why this models a FRETIK TURN and not a blended price
 *
 * The previous version scored `(effectiveInput × 3 + output) / 4` — the
 * industry-standard 3:1 input:output blend. Two measurements (2026-07-26)
 * showed that ranks the fleet wrongly:
 *
 * 1. **A Fretik turn is nothing like 3:1.** The agent re-sends its whole
 *    context every tool-loop step: 27 103 static tokens (system prompt + tool
 *    descriptions + skills, per `bun run measure:tokens`) × ~3 steps, against a
 *    few hundred output tokens. Input is 87-98 % of the bill, so the
 *    CACHE-READ rate dominates and the headline input price barely matters.
 *    OpenAI discounts cached input to 10 % of input; some upstreams only reach
 *    19-20 %. That single ratio reorders everything.
 * 2. **Verbosity varies ~20× and was ignored entirely.** Models spend wildly
 *    different output budgets to answer the same question — 6 690 tokens per
 *    Artificial Analysis task for GPT-5.6 Sol, 45 277 for DeepSeek V4 Flash.
 *    Scoring price-per-token while ignoring tokens-per-answer moved models by
 *    up to 8 rank positions versus AA's measured per-task cost. MiniMax M3
 *    looks 4th-cheapest on headline price and is 7th in reality.
 *
 * So: estimate a real turn. Neither published number transfers directly — AA's
 * own per-task cost is output-dominated because its benchmark tasks are, which
 * is the mirror image of our error — so we combine OUR turn shape with THEIR
 * verbosity measurement.
 *
 * A **log scale** is used because prices span orders of magnitude — a linear
 * map would crush every budget model to ~0. Bounds are FIXED (not
 * set-relative) so a model's level is stable regardless of which models are
 * displayed together, and comparisons stay meaningful across releases.
 */

/**
 * Cacheable agent context re-sent on every tool-loop step: static system-prompt
 * prefix + tool descriptions + bundled skills. Measured, not estimated — run
 * `bun run measure:tokens` (2026-07-26: prefix 13 211 + tools 12 927 + skills
 * 965). Update alongside any prompt/tool-surface change.
 */
const STATIC_CONTEXT_TOKENS = 27_103;

/** Conversation history carried per step, on top of the static prefix. */
const HISTORY_TOKENS = 3_000;

/** Tool-loop steps in a representative turn. */
const STEPS_PER_TURN = 3;

/**
 * Share of the static context served from cache. High by design: the prompt
 * prefix is byte-stable (`static_prefix_cache_works`) and provider routing is
 * pinned per profile so the KV cache stays warm across round-trips.
 */
const CACHE_HIT_RATE = 0.9;

/**
 * Output tokens a representative turn emits for a model of MEDIAN verbosity. A
 * chat turn is far shorter than an Artificial Analysis benchmark task, so a
 * profile's `verbosity.outputTokensPerTask` is applied as a RATIO against the
 * fleet median rather than used directly.
 */
const MEDIAN_TURN_OUTPUT_TOKENS = 700;

/**
 * Fleet-median `verbosity.outputTokensPerTask`, the denominator of that ratio.
 * A constant rather than a computed median so a model's `costLevel` does not
 * shift when an unrelated profile is added or removed.
 */
const MEDIAN_OUTPUT_TOKENS_PER_TASK = 19_692;

/** Cache-write premium for `explicit-breakpoints` families (Anthropic). */
const EXPLICIT_CACHE_WRITE_MULTIPLIER = 1.25;

/** Share of input written to cache each turn (explicit-breakpoints only). */
const EXPLICIT_CACHE_WRITE_SHARE = 0.1;

// Per-turn USD bounds spanning budget → frontier, on the model below.
const COST_MIN_PER_TURN = 0.002;
const COST_MAX_PER_TURN = 0.5;
const LOG_MIN = Math.log10(COST_MIN_PER_TURN);
const LOG_MAX = Math.log10(COST_MAX_PER_TURN);

/**
 * Estimated output tokens for one turn, scaled by the profile's measured
 * verbosity. Profiles with no AA verbosity data fall back to the median — the
 * neutral assumption, never a penalty.
 */
const outputTokensForTurn = (profile: ModelProfile): number => {
  const perTask = profile.assessment.verbosity?.outputTokensPerTask;
  if (perTask === undefined || perTask <= 0) return MEDIAN_TURN_OUTPUT_TOKENS;
  return MEDIAN_TURN_OUTPUT_TOKENS * (perTask / MEDIAN_OUTPUT_TOKENS_PER_TASK);
};

/** Input cost of one turn: cached prefix + fresh remainder, across all steps. */
const inputCostPerTurn = (profile: ModelProfile): number => {
  const { inputPerMTok, cacheReadPerMTok } = profile.assessment.pricing;
  const strategy = profile.assessment.cache.strategy;
  // No known cached rate (or no caching at all) → every input token is full
  // price. Modelling a write premium without a read discount would only
  // overstate cost, so it is skipped.
  const cachedRate =
    strategy === "none" || cacheReadPerMTok === undefined
      ? inputPerMTok
      : cacheReadPerMTok;

  const cachedTokens = STATIC_CONTEXT_TOKENS * CACHE_HIT_RATE;
  const freshTokens =
    STATIC_CONTEXT_TOKENS * (1 - CACHE_HIT_RATE) + HISTORY_TOKENS;

  // Anthropic-style explicit caching also PAYS to write breakpoints (~1.25×
  // input); implicit caches write for free. Applied on top of the fresh share.
  const writeTokens =
    strategy === "explicit-breakpoints"
      ? STATIC_CONTEXT_TOKENS * EXPLICIT_CACHE_WRITE_SHARE
      : 0;

  return (
    (STEPS_PER_TURN *
      (cachedTokens * cachedRate +
        freshTokens * inputPerMTok +
        writeTokens * EXPLICIT_CACHE_WRITE_MULTIPLIER * inputPerMTok)) /
    1_000_000
  );
};

/**
 * Estimated USD for one representative chat turn. Exported so the eval gate and
 * any future credit accounting can reason in the same currency as the picker.
 */
export const estimatedCostPerTurn = (profile: ModelProfile): number =>
  inputCostPerTurn(profile) +
  (outputTokensForTurn(profile) * profile.assessment.pricing.outputPerMTok) /
    1_000_000;

export const costLevelFromProfile = (profile: ModelProfile): number => {
  const perTurn = estimatedCostPerTurn(profile);
  const clamped = Math.min(
    Math.max(perTurn, COST_MIN_PER_TURN),
    COST_MAX_PER_TURN,
  );
  const t = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return Math.round(t * 100);
};
