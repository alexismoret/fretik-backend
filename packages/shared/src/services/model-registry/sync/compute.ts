import {
  normalizeProviderList,
  normalizeProviderName,
} from "../../../model-registry/provider-names";
import type {
  DynamicProfile,
  EndpointStat,
  PricingSnapshot,
  ProviderPool,
} from "../../../model-registry/types";
import type { GatewayCatalogEntry } from "./sources/gateway-catalog";

/**
 * Everything the sync DECIDES, as pure functions.
 *
 * The split is deliberate and it is the same one `policy.ts` makes: the sources
 * gather, this file decides, `run.ts` writes. Nothing here reads a clock, a
 * database or the network, which is why the numbers that gate publication and
 * bill credits can be asserted in a unit test with an empty environment instead
 * of being discovered in production.
 */

/**
 * Held back from the smallest endpoint context before anything budgets against
 * it. Token counts are estimates at every layer — the tokenizer we count with
 * is not always the tokenizer the upstream bills with, and a system prompt
 * grows between the moment compaction decides and the moment the request goes
 * out. The margin is what stops a right-at-the-limit turn from becoming a hard
 * 400 instead of one more compaction round.
 */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 2048;

/**
 * A turn is mostly prompt: system prompt, tool schemas, conversation history
 * and tool results dwarf the answer. 0.75/0.25 is an ASSUMPTION, not a
 * measurement — revisit it against real usage once the credit system bills
 * enough turns to compute the fleet's true ratio.
 */
export const BLENDED_INPUT_WEIGHT = 0.75;

/**
 * The cost a credit multiplier of 1.0 means: USD per 1M tokens, blended.
 *
 * Anchored on the measured median, not invented: across the 236 language models
 * the gateway catalogue priced on 2026-08-29, the median blended cost was
 * $1.002/MTok (p25 $0.385, p75 $3.375). So 1× is "the median model", a
 * $0.30/$1.20 workhorse lands near 0.5×, and a $15/$75 flagship near 20×.
 * Changing this renumbers every model at once, which is the point — it is a
 * single dial, not a per-model table.
 */
export const REFERENCE_BLENDED_COST_PER_MTOK = 1;

/** Nothing bills at zero. A free model still costs us the request. */
export const MIN_CREDIT_MULTIPLIER = 0.1;

/**
 * Relative blended-price change that is worth waking someone for. Upstreams
 * adjust prices by single-digit percents; a 50 % move is a repricing, a tier
 * change, or a parse bug, and all three want a human.
 */
export const PRICE_JUMP_THRESHOLD = 0.5;

/**
 * Blended price band → product tier, from the same 2026-08-29 distribution:
 * the boundaries ARE the catalogue's quartiles, so the bands stay meaningful as
 * a description of the market rather than of one vendor's line-up.
 * p25 = $0.385, p75 = $3.375 — rounded outward to $0.5 and $3.
 */
export const TIER_PRICE_BANDS = { utilityBelow: 0.5, flagshipAtOrAbove: 3 };

const isFiniteNumber = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return undefined;
  const lower = sorted[mid - 1];
  if (sorted.length % 2 === 1 || lower === undefined) return upper;
  // Round the even-count average: (0.12 + 0.13) / 2 must not be 0.125000000001
  // in a column the price-jump detector compares against tomorrow.
  return Math.round(((lower + upper) / 2) * 1e6) / 1e6;
};

/** What one million tokens of an average turn costs. See the weight above. */
export const blendedPricePerMTok = (pricing: PricingSnapshot): number =>
  pricing.inputPerMTok * BLENDED_INPUT_WEIGHT +
  pricing.outputPerMTok * (1 - BLENDED_INPUT_WEIGHT);

/**
 * Fold two sources' views of the same pool into one.
 *
 * `primary` is the transport a call actually routes through, so it WINS on
 * every field it reports; `enrichment` only fills gaps. Its reason for existing
 * is `quantization`, which no other source publishes — `fp4` versus `bf16` is a
 * quality difference invisible in every other column.
 *
 * Providers that exist ONLY in the enrichment source are DROPPED. They are real
 * hosts, but not on the transport we route through, so counting them would
 * inflate the pool, raise the context minimum and move the price median toward
 * endpoints no call can reach.
 */
export const mergeEndpointStats = (
  primary: EndpointStat[],
  enrichment: EndpointStat[],
): EndpointStat[] => {
  const extras = new Map<string, EndpointStat>();
  for (const stat of enrichment) {
    extras.set(normalizeProviderName(stat.provider), stat);
  }
  return primary.map((stat) => {
    const extra = extras.get(normalizeProviderName(stat.provider));
    if (extra === undefined) return stat;
    return {
      ...stat,
      // Both halves are kept, and the primary wins a collision: each source
      // only ever knows its OWN transport's spelling, so the union is what
      // makes a transport switch route to the hosts the pool names. Dropping
      // the enrichment's half would leave the other transport's pool
      // unaddressable the moment it was switched to.
      wireNames: { ...extra.wireNames, ...stat.wireNames },
      maxCompletionTokens:
        stat.maxCompletionTokens ?? extra.maxCompletionTokens,
      pricing: {
        ...stat.pricing,
        cacheReadPerMTok:
          stat.pricing.cacheReadPerMTok ?? extra.pricing.cacheReadPerMTok,
        cacheWritePerMTok:
          stat.pricing.cacheWritePerMTok ?? extra.pricing.cacheWritePerMTok,
      },
      supportsImplicitCaching:
        stat.supportsImplicitCaching ?? extra.supportsImplicitCaching,
      // Each source fills what the other cannot see, and the two gaps are
      // symmetrical: only the gateway publishes a per-endpoint zero-retention
      // stance, only OpenRouter publishes a quantization. A model routed
      // through either transport therefore gets both answers, which is the
      // whole reason the enrichment fetch is worth its round trip.
      hasZdr: stat.hasZdr ?? extra.hasZdr,
      quantization: stat.quantization ?? extra.quantization,
      uptime15m: stat.uptime15m ?? extra.uptime15m,
      uptime1h: stat.uptime1h ?? extra.uptime1h,
      uptime1d: stat.uptime1d ?? extra.uptime1d,
      throughputP50: stat.throughputP50 ?? extra.throughputP50,
      throughputP95: stat.throughputP95 ?? extra.throughputP95,
      latencyP50Ms: stat.latencyP50Ms ?? extra.latencyP50Ms,
      latencyP95Ms: stat.latencyP95Ms ?? extra.latencyP95Ms,
      status: stat.status ?? extra.status,
    };
  });
};

export interface AllowedPoolInput {
  declaredPool?: ProviderPool;
  /** Quarantines exhausted the vetted pool, so `only` is not applied. */
  poolWidened: boolean;
  /** Normalised names the breaker pulled out, already filtered to this transport. */
  quarantined: string[];
  endpoints: EndpointStat[];
  /** Drop endpoints that do not advertise `tools`. */
  requireTools: boolean;
  /** Drop endpoints that DECLARE no zero-retention agreement. */
  requireZdr?: boolean;
  quantizationFloor?: readonly string[];
}

export interface AllowedPool {
  endpoints: EndpointStat[];
  excluded: { provider: string; reason: string }[];
}

/**
 * The endpoints a call can actually land on, and WHY each of the others cannot.
 *
 * Order matters, because each endpoint is reported under the first rule that
 * removed it and the first reason is the actionable one: "quarantined" tells an
 * operator to look at an incident, "not in the declared pool" tells them to
 * edit a pool. Quarantine therefore comes before `only`, which the breaker
 * itself relies on — a widened pool skips `only` but never skips a quarantine.
 *
 * The quantization floor is applied ONLY to endpoints that report a
 * quantization. Missing data never excludes anybody: the gateway reports
 * `null` on every endpoint we have looked at, so treating absence as a failure
 * would empty the pool of every gateway-served model at once.
 */
export const buildAllowedPool = (input: AllowedPoolInput): AllowedPool => {
  const quarantined = new Set(normalizeProviderList(input.quarantined));
  const declaredOnly = input.poolWidened
    ? []
    : normalizeProviderList(input.declaredPool?.only ?? []);
  // An empty `only` is a degenerate declaration, not "allow nothing" — the same
  // reading `effectivePoolFor` uses when it decides whether to send one.
  const only = declaredOnly.length > 0 ? new Set(declaredOnly) : undefined;
  const ignore = new Set(
    normalizeProviderList(input.declaredPool?.ignore ?? []),
  );
  const floor =
    input.quantizationFloor === undefined
      ? undefined
      : new Set(input.quantizationFloor.map((q) => q.toLowerCase()));

  const endpoints: EndpointStat[] = [];
  const excluded: { provider: string; reason: string }[] = [];

  for (const endpoint of input.endpoints) {
    const provider = normalizeProviderName(endpoint.provider);
    if (quarantined.has(provider)) {
      excluded.push({ provider, reason: "quarantined by the breaker" });
      continue;
    }
    if (only !== undefined && !only.has(provider)) {
      excluded.push({ provider, reason: "not in the declared `only` pool" });
      continue;
    }
    if (ignore.has(provider)) {
      excluded.push({ provider, reason: "listed in the declared `ignore`" });
      continue;
    }
    if (input.requireTools && !endpoint.supportedParameters.includes("tools")) {
      excluded.push({ provider, reason: "does not advertise `tools`" });
      continue;
    }
    // Only a DECLARED `false` excludes. `undefined` means the source has not
    // established the host's stance, and routing still carries
    // `zeroDataRetention: true`, which filters at request time — so treating
    // silence as a refusal would shrink the pool on the strength of missing
    // data while changing nothing about what the request actually reaches.
    if (input.requireZdr && endpoint.hasZdr === false) {
      excluded.push({ provider, reason: "no zero-retention agreement" });
      continue;
    }
    if (
      floor !== undefined &&
      endpoint.quantization !== undefined &&
      !floor.has(endpoint.quantization.toLowerCase())
    ) {
      excluded.push({
        provider,
        reason: `quantization ${endpoint.quantization} below floor ${[...floor].join("/")}`,
      });
      continue;
    }
    endpoints.push(endpoint);
  }

  return { endpoints, excluded };
};

/**
 * The context the compaction threshold may budget against: the SMALLEST
 * endpoint in the pool, minus the safety margin. Routing picks per request, so
 * budgeting against the largest overflows the moment a turn lands on the
 * smallest — endpoints for one model spanned 40 960 to 262 144 tokens on
 * 2026-08-29.
 *
 * `maxOutput` is the smallest reported cap, or `null` when nobody reports one:
 * a pool where no endpoint declares a limit has no limit we can honestly claim.
 */
export const computeEffectiveContext = (
  endpoints: EndpointStat[],
  marginTokens: number = CONTEXT_SAFETY_MARGIN_TOKENS,
): { contextLength: number; maxOutput: number | null } => {
  const contexts = endpoints.map((e) => e.contextLength).filter(isFiniteNumber);
  const caps = endpoints
    .map((e) => e.maxCompletionTokens)
    .filter(isFiniteNumber);
  return {
    contextLength:
      contexts.length === 0
        ? 0
        : Math.max(0, Math.min(...contexts) - marginTokens),
    maxOutput: caps.length === 0 ? null : Math.min(...caps),
  };
};

/**
 * The pool's price: the MEDIAN per field, not the minimum and not the average.
 * The minimum is a price only one host charges, and the average is moved by a
 * single outlier — one endpoint of a model priced 6× its siblings would make
 * the whole pool look expensive. Routing lands on the middle of the pool, so
 * the middle is what a turn costs.
 *
 * Cache fields are OMITTED when no endpoint quotes one: an absent cache rate
 * means "not offered", and a zero would read as "free".
 */
export const computePoolPricing = (
  endpoints: EndpointStat[],
): PricingSnapshot => {
  const across = (
    pick: (e: EndpointStat) => number | undefined,
  ): number | undefined => median(endpoints.map(pick).filter(isFiniteNumber));

  const snapshot: PricingSnapshot = {
    inputPerMTok: across((e) => e.pricing.inputPerMTok) ?? 0,
    outputPerMTok: across((e) => e.pricing.outputPerMTok) ?? 0,
  };
  const cacheRead = across((e) => e.pricing.cacheReadPerMTok);
  if (cacheRead !== undefined) snapshot.cacheReadPerMTok = cacheRead;
  const cacheWrite = across((e) => e.pricing.cacheWritePerMTok);
  if (cacheWrite !== undefined) snapshot.cacheWritePerMTok = cacheWrite;
  return snapshot;
};

/**
 * What one turn on this model costs relative to the reference model — the
 * number the future credit system bills off.
 *
 * Deliberately COARSE: two decimals, floored, derived from one blended price.
 * A multiplier that moved with every endpoint's daily repricing would be
 * unquotable to a customer; this one changes when the model's price band
 * changes, and the reference constant renumbers the whole fleet at once.
 */
export const computeCreditMultiplier = (
  pricing: PricingSnapshot,
  reference: number = REFERENCE_BLENDED_COST_PER_MTOK,
): number =>
  Math.max(
    MIN_CREDIT_MULTIPLIER,
    Math.round((blendedPricePerMTok(pricing) / reference) * 100) / 100,
  );

/**
 * A profile for a model nobody wrote a profile for, built from catalogue FACTS
 * only. Capabilities come from the `tags` array and never from the name: `-mini`
 * and `-flash` are marketing, `tool-use` and `vision` are declarations the
 * gateway will be held to. A hand-written TypeScript profile, when one exists,
 * wins over this field by field.
 */
export const deriveDynamicProfile = (
  entry: GatewayCatalogEntry,
  now: Date,
): DynamicProfile => {
  const tags = new Set(entry.tags);
  const inputModalities = ["text"];
  if (tags.has("vision")) inputModalities.push("image");
  if (tags.has("file-input")) inputModalities.push("file");

  const blended = blendedPricePerMTok({
    inputPerMTok: entry.pricing.inputPerMTok ?? 0,
    outputPerMTok: entry.pricing.outputPerMTok ?? 0,
  });
  const tier =
    blended >= TIER_PRICE_BANDS.flagshipAtOrAbove
      ? "flagship"
      : blended < TIER_PRICE_BANDS.utilityBelow
        ? "utility"
        : "workhorse";

  return {
    displayName: entry.name,
    family: entry.owner,
    tiers: [tier],
    contextLength: entry.contextWindow ?? 0,
    maxCompletionTokens: entry.maxTokens,
    inputModalities,
    outputModalities: ["text"],
    supportedParameters: entry.supportedParameters,
    supportsReasoning: tags.has("reasoning"),
    supportsTools: tags.has("tool-use"),
    derivedFrom: {
      source: "vercel-ai-gateway:/v1/models",
      at: now.toISOString(),
    },
  };
};

/**
 * The signed relative change in blended price, or `null` when there is nothing
 * to compare or the move is under the threshold. Signed because a HALVING is
 * worth reading too: it is either good news worth acting on or a parse bug, and
 * both want the same look.
 */
export const detectPriceJump = (
  previous: PricingSnapshot | null,
  next: PricingSnapshot,
): number | null => {
  if (previous === null) return null;
  const before = blendedPricePerMTok(previous);
  // No baseline: a first sync, or a row that never carried a real price. A
  // relative change from zero is infinite, which is not a signal.
  if (before <= 0) return null;
  const change = (blendedPricePerMTok(next) - before) / before;
  return Math.abs(change) >= PRICE_JUMP_THRESHOLD ? change : null;
};
