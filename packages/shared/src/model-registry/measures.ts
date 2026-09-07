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
 * How a vendor charges for its prompt cache — read off the PRICES, which is the
 * only place any catalogue states it.
 *
 * Four shapes, all measured from the OpenRouter catalogue on 2026-08-30 and
 * separated unambiguously by the write-to-input ratio:
 *
 *  - **`write-premium`** (Anthropic, OpenAI, Qwen) — the write costs MORE than
 *    an uncached token, clustered tightly at 1.25-1.33×. The first pass is
 *    dearer than no cache at all, so a 0.1× read rate is worth far less than it
 *    looks: those models correct to ×0.47, not ×0.15.
 *  - **`storage-rate`** (Google) — a write quoted BELOW the input price is a
 *    per-hour charge for HOLDING the cache, not a per-token write.
 *    `gemini-3.7-flash` quotes $0.042 against $0.750; billing it as a write
 *    would make Gemini look 18× cheaper than it is. Storage rates sit at
 *    0.05-0.3×, nowhere near the premium cluster.
 *  - **`free-writes`** (DeepSeek, GLM, MiniMax, Kimi) — a read discount and no
 *    write charge at all. Caching is pure saving.
 *  - **`none`** — no read discount published, or one quoted at full price.
 *    CoreWeave prices `gpt-oss-120b` cache reads at exactly the input rate; a
 *    "discount" of 1.0× is not a discount.
 *
 * This replaced a hand-written `cache.strategy` on each curated profile, which
 * was wrong on 5 of 22 models when the two were compared: `gpt-oss-120b` and
 * `gpt-oss-20b` were recorded as having no cache while Groq, Fireworks,
 * DigitalOcean and Parasail all publish a read discount, and the three GPT-5.6
 * profiles said `implicit` where the prices say a write premium. The old field
 * also conflated two independent questions — how the vendor CHARGES, and
 * whether the caller must place `cache_control` markers. Only the first is a
 * pricing fact; the second is a dialect fact and lives with the dialect.
 */
export type CacheShape =
  "write-premium" | "storage-rate" | "free-writes" | "none";

export const cacheShape = (pricing: PricingSnapshot): CacheShape => {
  const { inputPerMTok, cacheReadPerMTok, cacheWritePerMTok } = pricing;
  if (cacheWritePerMTok !== undefined && cacheWritePerMTok >= inputPerMTok)
    return "write-premium";
  if (cacheReadPerMTok === undefined || cacheReadPerMTok >= inputPerMTok)
    return "none";
  return cacheWritePerMTok === undefined ? "free-writes" : "storage-rate";
};

/**
 * Whether an upstream ACTUALLY serves prompt cache reads — as opposed to
 * publishing a price for them.
 *
 * `cacheShape` above reads the PRICE LIST, which is a promise. This reads
 * OBSERVATIONS, and the two disagree often enough to matter: measured
 * 2026-09-07, `supports_implicit_caching` is `false` on all 15 endpoints of
 * `deepseek-v4-flash` and all 22 of `gpt-oss-120b`, while OpenRouter's own
 * per-endpoint statistics put StreamLake at 82 % and DeepInfra at 55 % on the
 * first of those. A flag a vendor forgot to set is not a measurement, and the
 * policy rule that read it as one reported "no endpoint reports implicit
 * caching" across a fleet that caches perfectly well.
 *
 * Three sources, strictly ranked, because they are not equally trustworthy:
 *
 *  1. **`measured`** — our own traffic, from `model_telemetry_rollups`. It
 *     describes the service WE get on the route WE take, and no other source
 *     can. Requires enough calls to mean something.
 *  2. **`probe`** — a bench run: one cold call then two warm ones over a
 *     byte-identical prefix, judged on the BILLED cost. Independent of anyone
 *     else's traffic, which is what makes it the answer for a host we have
 *     never routed to.
 *  3. **`openrouter`** — the platform-wide hit rate for that endpoint. It mixes
 *     the host's capability with the shape of everybody else's traffic (agent
 *     sessions with stable prefixes score high; one-shots score low) and with
 *     OpenRouter's own routing, so it is admitted only above a volume floor and
 *     only when nothing better exists.
 *
 * Absent everywhere is `unknown`, NEVER `no-cache`: "we have not looked" and
 * "we looked and there is none" may not share a value, and only the second one
 * is allowed to remove a host from a pool.
 */
export type CacheVerdict = "caches" | "no-cache" | "unknown";

/** Which observation decided a `CacheVerdict`. Rendered to the operator. */
export type CacheEvidenceSource = "measured" | "probe" | "openrouter" | "none";

export interface CacheEvidence {
  verdict: CacheVerdict;
  source: CacheEvidenceSource;
  /** The deciding figure, on the scale its source uses. */
  value?: number;
}

/** The observation fields `cacheEvidenceFor` reads off an endpoint. */
export interface CacheEvidenceInput {
  measuredCacheReadRatio?: number;
  measuredCacheSamples?: number;
  probeWarmCostRatio?: number;
  cacheHitRate?: number;
  volumeTokens?: number;
}

/**
 * Share of prompt tokens read from cache below which an upstream is not
 * caching for us in any useful way.
 *
 * Deliberately low. The question is "does this host hold a prefix at all",
 * not "how good is it": a genuine cache under our own traffic sits far above
 * this (75 % fleet-wide, `CACHE_HIT_RATE` above), and everything in the 0-20 %
 * band is a host that either never holds a prefix or drops it between turns,
 * which costs the same.
 */
export const CACHE_EVIDENCE_MIN_RATE = 0.2;

/** Calls needed before our own ratio is a measurement rather than an anecdote. */
export const CACHE_EVIDENCE_MIN_SAMPLES = 50;

/**
 * Warm-to-cold cost ratio below which a bench probe proves a cache.
 *
 * A real cache read costs a tenth to a quarter of an uncached token, so a
 * warm call over a byte-identical prefix lands far under this. 0.8 leaves room
 * for the completion side of the bill, which is not cached and does not shrink.
 */
export const CACHE_EVIDENCE_MAX_WARM_COST_RATIO = 0.8;

/**
 * Tokens an endpoint must have served, platform-wide, before OpenRouter's hit
 * rate is worth reading.
 *
 * Measured 2026-09-07 on `deepseek-v4-flash`: the fifteen endpoints span 1 GTok
 * (Azure, 29 %) to 198 GTok (StreamLake, 83 %), and the low-volume tail is
 * where the figure is dominated by whichever handful of callers happened to use
 * it. 1e8 keeps the hosts with a week of real traffic behind them and answers
 * `unknown` for the rest — which is the honest answer for a model nobody else
 * uses much.
 */
export const PROVIDER_STATS_MIN_VOLUME_TOKENS = 1e8;

export const cacheEvidenceFor = (
  endpoint: CacheEvidenceInput,
): CacheEvidence => {
  const {
    measuredCacheReadRatio,
    measuredCacheSamples,
    probeWarmCostRatio,
    cacheHitRate,
    volumeTokens,
  } = endpoint;

  if (
    isFiniteNumber(measuredCacheReadRatio) &&
    isFiniteNumber(measuredCacheSamples) &&
    measuredCacheSamples >= CACHE_EVIDENCE_MIN_SAMPLES
  ) {
    return {
      verdict:
        measuredCacheReadRatio >= CACHE_EVIDENCE_MIN_RATE
          ? "caches"
          : "no-cache",
      source: "measured",
      value: measuredCacheReadRatio,
    };
  }

  if (isFiniteNumber(probeWarmCostRatio)) {
    return {
      verdict:
        probeWarmCostRatio <= CACHE_EVIDENCE_MAX_WARM_COST_RATIO
          ? "caches"
          : "no-cache",
      source: "probe",
      value: probeWarmCostRatio,
    };
  }

  if (
    isFiniteNumber(cacheHitRate) &&
    isFiniteNumber(volumeTokens) &&
    volumeTokens >= PROVIDER_STATS_MIN_VOLUME_TOKENS
  ) {
    return {
      verdict: cacheHitRate >= CACHE_EVIDENCE_MIN_RATE ? "caches" : "no-cache",
      source: "openrouter",
      value: cacheHitRate,
    };
  }

  return { verdict: "unknown", source: "none" };
};

/**
 * What a POOL can be said to do about caching.
 *
 * `caches` as soon as one member does, because routing lands on one host per
 * request and a single caching member is a cache the model can get. `unknown`
 * only when no member carries any evidence at all — one measured host settles
 * the question for the rule that reads this, whatever the others are.
 */
export const poolCacheVerdict = (
  endpoints: readonly CacheEvidenceInput[],
): CacheVerdict => {
  let sawEvidence = false;
  for (const endpoint of endpoints) {
    const { verdict } = cacheEvidenceFor(endpoint);
    if (verdict === "caches") return "caches";
    if (verdict === "no-cache") sawEvidence = true;
  }
  return sawEvidence ? "no-cache" : "unknown";
};

/**
 * What one million tokens of an average turn costs, cache included.
 *
 * Every prompt token is one of two things: a HIT, billed at the cache-read rate,
 * or a MISS that also has to be written into the cache. Both fall back to the
 * plain input price when the catalogue publishes no rate — a discount no vendor
 * has published is not one we may assume, and 160 of the 449 priced language
 * models publish none.
 *
 * The write side is where the vendors genuinely differ, and `cacheShape` above
 * is the single reading of that difference: only a real premium is billed, and
 * a storage rate is ignored rather than mistaken for one.
 */
export const blendedPricePerMTok = (pricing: PricingSnapshot): number => {
  const { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok } =
    pricing;
  const readPrice = cacheReadPerMTok ?? inputPerMTok;
  const missPrice =
    cacheShape(pricing) === "write-premium" && cacheWritePerMTok !== undefined
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
