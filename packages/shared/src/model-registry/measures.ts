import type { PricingSnapshot } from "./types";

/**
 * The pure measures every layer of the engine computes the SAME way, and the
 * market figures they are calibrated against.
 *
 * They live here rather than beside their first caller because each one had
 * already been written twice by 2026-08-30 — the blended weight in the sync's
 * `compute.ts` and again in `@fretik/ai`'s profile synthesis — and two spellings
 * of one number is how a fleet ends up with two answers to "what does this model
 * cost". Nothing here reads a clock, a database or the network.
 *
 * Every constant below is MEASURED and dated. Each one replaced an assumption
 * carrying a comment that asked for the real figure once there was traffic to
 * compute it from; that traffic now exists, so re-derive them here rather than
 * anywhere else when it moves.
 */

/**
 * How a turn's tokens split between prompt and completion.
 *
 * Langfuse production traces, every generation, 2026-08-30: the prompt share is
 * **97.45 % over 30 days, 97.36 % over 60, 97.42 % over 90**, and 97.68 % when
 * recomputed from the per-type token counters rather than the totals. Restricted
 * to the `production` environment: 96.96 % / 97.17 %. It was `0.75` before, from
 * no measurement at all.
 *
 * The cause is structural, which is why the figure is this stable and why it
 * will stay stable: an agentic turn RE-SENDS ITS WHOLE HISTORY on every step.
 * One sampled 24-generation turn grew 30 151 → 38 204 → 82 114 → 139 324 prompt
 * tokens while emitting a few hundred output tokens per step. Windows shorter
 * than a fortnight read lower (85-90 %) because a handful of long sessions have
 * not averaged out yet — do not recalibrate off a week.
 *
 * Consequence worth stating plainly: at this weight the completion price barely
 * moves the blended figure. On our measured mix that is CORRECT — 2.6 % of
 * tokens are output — but it is a claim about our workload, not about any model.
 * A product that started generating long documents would have to re-measure it.
 */
export const BLENDED_INPUT_WEIGHT = 0.97;

/**
 * The share of prompt tokens served from the upstream's prompt cache.
 *
 * Measured the same day and from the same traces: **74.6 % over 90 days, 75.1 %
 * over 30** (2.12e9 cached against 7.24e8 uncached prompt tokens over 90 days).
 * Read from the AI SDK's own `input` / `input_cached_tokens` counters, which
 * have the history; our middleware's `input_cache_read` key is days old and its
 * `input` means the FULL prompt, so the two must never share a denominator.
 *
 * This term is not a refinement, it is the dominant one. At a 97 % prompt share
 * the input column IS the bill, and a cache read costs a tenth to a quarter of
 * it — pricing every prompt token at list overstated the fleet by roughly 2.5×
 * and, worse, overstated it UNEVENLY: measured across the 22 published models
 * the correction spans ×0.34 (`deepseek-v4-pro`, cache reads at 3 % of input) to
 * ×1.00 (`mistral-medium-3.5`, which publishes no cache rate at all).
 */
export const CACHE_HIT_RATE = 0.75;

/**
 * What one million tokens of an average turn costs, cache included.
 *
 * Every prompt token is one of two things: a HIT, billed at the cache-read rate,
 * or a MISS that also has to be written into the cache. Both fall back to the
 * plain input price when the catalogue publishes no rate — a discount no vendor
 * has published is not one we may assume, and 160 of the 449 priced language
 * models publish none.
 *
 * The write side is where the vendors genuinely differ, and it is why this is
 * not simply "input × 0.2". Three shapes, all measured from the OpenRouter
 * catalogue on 2026-08-30:
 *
 *  - **No write charge** (DeepSeek, GLM, MiniMax, Kimi): caching is pure saving.
 *  - **A write PREMIUM of ~1.25×** (Anthropic, OpenAI, Qwen — `qwen3.8-flash`
 *    reads at 0.107× but writes at 1.33×). The first pass costs more than an
 *    uncached one, so a 0.1× read rate is worth far less than it looks: those
 *    models correct to ×0.47, not to ×0.15.
 *  - **A STORAGE rate** (Google): `gemini-3.7-flash` quotes $0.042 against a
 *    $0.750 input — a per-hour price for holding the cache, not a per-token
 *    write. Reading it as a write price would make Gemini look 18× cheaper than
 *    it is, so a quoted write BELOW the input price is treated as storage and
 *    ignored. The separation in the data is unambiguous: premiums cluster at
 *    1.25-1.33×, storage rates at 0.05-0.3×.
 */
export const blendedPricePerMTok = (pricing: PricingSnapshot): number => {
  const { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok } =
    pricing;
  const readPrice = cacheReadPerMTok ?? inputPerMTok;
  const missPrice =
    cacheWritePerMTok !== undefined && cacheWritePerMTok >= inputPerMTok
      ? cacheWritePerMTok
      : inputPerMTok;
  const effectiveInput =
    missPrice * (1 - CACHE_HIT_RATE) + readPrice * CACHE_HIT_RATE;
  return (
    effectiveInput * BLENDED_INPUT_WEIGHT +
    outputPerMTok * (1 - BLENDED_INPUT_WEIGHT)
  );
};

/**
 * Where the market sits, in blended USD per MTok — the anchor for every
 * boundary that means "cheap" or "expensive".
 *
 * Measured 2026-08-30 over the 449 priced language models the three catalogues
 * list between them (600 merged entries), THROUGH THE FUNCTION ABOVE: p25
 * $0.127, median $0.343, p75 $0.860.
 *
 * They are re-derived from scratch whenever the weight or the hit rate moves,
 * and that is the whole reason they live in this file. The previous boundaries
 * ($0.50 / $3.00) were the same quartiles computed at a 0.75 weight with no
 * cache term; leaving them in place while both moved would have silently
 * reclassified three quarters of the catalogue.
 */
export const MARKET_BLENDED_QUARTILES = {
  p25: 0.13,
  median: 0.35,
  p75: 0.85,
} as const;

/**
 * The middle of a pool, per column.
 *
 * The MEDIAN, never the minimum and never the average: the minimum is a figure
 * only one host offers, and the average is moved by a single outlier — one
 * endpoint priced 6× its siblings would make the whole pool look expensive.
 * Routing lands in the middle of the pool, so the middle is what a turn gets.
 *
 * The even-count average is rounded to 1e-6 because these numbers are compared
 * against yesterday's: `(0.12 + 0.13) / 2` must not be `0.125000000001` in a
 * column the price-jump detector diffs on the next pass.
 */
export const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return undefined;
  const lower = sorted[mid - 1];
  if (sorted.length % 2 === 1 || lower === undefined) return upper;
  return Math.round(((lower + upper) / 2) * 1e6) / 1e6;
};

/** Narrows away the `undefined` a catalogue column is allowed to be. */
export const isFiniteNumber = (
  value: number | null | undefined,
): value is number => typeof value === "number" && Number.isFinite(value);
