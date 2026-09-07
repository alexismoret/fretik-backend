import type { MergedCatalogueEntry } from "../../../model-registry/catalogue";
import { withMeasuredExclusions } from "../../../model-registry/measured-exclusions";
import {
  blendedPricePerMTok,
  cacheEvidenceFor,
  isFiniteNumber,
  MARKET_BLENDED_QUARTILES,
  median,
} from "../../../model-registry/measures";
import {
  normalizeProviderList,
  normalizeProviderName,
} from "../../../model-registry/provider-names";
import type { PoolRequirements } from "../../../model-registry/requirements";
import type {
  DynamicProfile,
  EndpointStat,
  PricingSnapshot,
  ProviderPool,
} from "../../../model-registry/types";

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
 * The cost a credit multiplier of 1.0 means: USD per 1M tokens, blended.
 *
 * The market MEDIAN, so 1× is "the median model" — re-measured 2026-08-30 at
 * $0.343 across the 449 priced language models the three catalogues list
 * between them. It was `1` while the blend priced every prompt token at list
 * and weighted the split 0.75/0.25; both of those turned out to be wrong
 * (`measures.ts` carries the traffic that says so), and a reference left behind
 * would have quietly redefined 1× as "1.8× the median model".
 *
 * Changing this renumbers every model at once, which is the point — it is a
 * single dial, not a per-model table.
 */
export const REFERENCE_BLENDED_COST_PER_MTOK = MARKET_BLENDED_QUARTILES.median;

/** Nothing bills at zero. A free model still costs us the request. */
export const MIN_CREDIT_MULTIPLIER = 0.1;

/**
 * Relative blended-price change that is worth waking someone for. Upstreams
 * adjust prices by single-digit percents; a 50 % move is a repricing, a tier
 * change, or a parse bug, and all three want a human.
 */
export const PRICE_JUMP_THRESHOLD = 0.5;

/**
 * How small a host may be, against the best in its own pool, and still belong
 * to it.
 *
 * A pool is a set of INTERCHANGEABLE routes: a request goes to whichever is
 * free, so what the model can promise is what its smallest member can serve.
 * One host with a quarter of the context therefore does not add capacity, it
 * caps everybody — and until the pool stopped being a ratchet nothing could
 * make that happen, because pools never widened.
 *
 * Measured 2026-09-02 on the published fleet, where it is not hypothetical:
 * `glm-5.2` is capped at 260 096 tokens today by four hosts serving 262 144
 * while twenty serve 1 048 576. Dropping those four raises the model's usable
 * context by 3.8×. On `deepseek-v4-flash`, one host of twenty-one costs the
 * other twenty three quarters of theirs.
 *
 * A half is where the line sits because the market clusters at halves and the
 * next ratio up starts costing real capacity: at 0.75, `minimax-m3` and
 * `inkling` lose their 524 288-token hosts, which serve exactly half of their
 * best and are genuine members. At 0.5 they keep them.
 */
export const POOL_CONTEXT_SPREAD_RATIO = 0.5;

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
      // `hasZdr` is deliberately ABSENT from this fold: a zero-retention stance
      // belongs to a (transport, route) pair and never transfers.
      //
      // It used to be filled across sources on the reading that only the
      // gateway published one. That stopped being true when the OpenRouter ZDR
      // route list was added, and the two are not the same claim: the gateway
      // answers per HOST under Vercel's contracts, OpenRouter answers per ROUTE
      // under its own. Measured over the 37 models both serve (2026-09-02, 253
      // host pairs): they disagree outright on 16 — 11 where the gateway has an
      // agreement and no OpenRouter route does, 5 the other way — and the
      // gateway says nothing at all about 129, which the fold would have
      // answered with the other transport's contract. Filling a gap that way
      // admits a host into a pool on the strength of a route no call will take.
      quantization: stat.quantization ?? extra.quantization,
      supportsToolChoice: stat.supportsToolChoice ?? extra.supportsToolChoice,
      // Uptime, throughput, latency and status are ABSENT for the same reason
      // as `hasZdr`, and it is the same mistake wearing a different hat: they
      // are not facts about a host, they are OBSERVATIONS of one aggregator's
      // traffic to one route.
      //
      // Measured 2026-09-02 on `glm-5.3-flash`: the gateway clocks Morph at
      // 110 tokens/s while OpenRouter's own last-30-minutes p50 for the same
      // host and the same model is 41. Neither is wrong; they describe
      // different routes under different load. Folding one into the other
      // produces a number that belongs to no route at all — and that number is
      // what `throughput-floor` grades and what an operator compares against a
      // provider's dashboard when deciding whether the registry can be trusted.
      //
      // What the enrichment is FOR is the portable half: `quantization`, the
      // cache shape, the parameters a deployment accepts. Those describe how
      // the weights are served, and they travel.
      //
      // `measuredAt` therefore stays the primary's, carried by the spread: it
      // stamps measurements, and no measurement crosses any more. Taking the
      // enrichment's would date figures the enrichment did not contribute.
    };
  });
};

/**
 * Fold two endpoint lists into their UNION, field-merged on collision with `a`
 * winning. This is what an ACCUMULATOR needs and `mergeEndpointStats` is not:
 * that one maps over its primary alone, so seeding an empty accumulator and
 * merging each fetch into it yields `[]` forever — the exact bug that left the
 * cross-transport enrichment loop dead from the day it was written, silently,
 * because an empty enrichment merges into an unchanged primary.
 */
export const unionEndpointStats = (
  a: EndpointStat[],
  b: EndpointStat[],
): EndpointStat[] => {
  const have = new Set(a.map((stat) => normalizeProviderName(stat.provider)));
  return [
    ...mergeEndpointStats(a, b),
    ...b.filter((stat) => !have.has(normalizeProviderName(stat.provider))),
  ];
};

/**
 * Days a measurement survives without being re-observed. Within the window a
 * pass that could not measure keeps the previous figure (stamped with its
 * original `measuredAt`, so its age stays legible); past it the value falls,
 * because a fossil presented next to fresh numbers is a lie with a good seat.
 * 14 days = two weekly repricing/requantisation cycles — long enough to ride
 * out an idle host or a source incident, short enough that a dead credential
 * cannot coast on stale figures for a month.
 */
export const STAT_CARRY_MAX_DAYS = 14;

const MEASUREMENT_FIELDS = [
  "uptime5m",
  "uptime15m",
  "uptime1h",
  "uptime1d",
  "throughputP50",
  "throughputP95",
  "latencyP50Ms",
  "latencyP90Ms",
  "latencyP95Ms",
] as const;

export interface CarriedMeasurements {
  endpoints: EndpointStat[];
  /** Endpoints whose fresh fetch carried at least one measurement of its own. */
  freshlyMeasured: number;
  /** Endpoints keeping at least one previous figure this pass could not re-observe. */
  carriedForward: number;
}

/**
 * Keep yesterday's measurements where today's fetch has none — per FIELD, the
 * same contract `aaMetrics` has had all along ("absent stays absent; the
 * stored `fetchedAt` is what says how old a kept figure is"). `endpointStats`
 * had no such protection: one pass with a dead OpenRouter key overwrote every
 * measured percentile on the published fleet with `undefined`, reported `ok`,
 * and the throughput rules quietly stopped existing.
 *
 * An endpoint that measured anything itself keeps ITS stamp even when it also
 * carries old fields — the stamp answers "when did a source last see this
 * host", and mixing in the older date would age fresh evidence. Only an
 * endpoint with nothing fresh keeps the stored stamp, which is what lets the
 * expiry above retire it. Stored stats with no stamp (graded before the field
 * existed) are never carried: their age is unknowable, and a figure of
 * unknowable age is exactly what this function exists to stop writing.
 */
export const carryForwardMeasurements = (
  fresh: EndpointStat[],
  stored: readonly EndpointStat[] | null,
  now: Date,
): CarriedMeasurements => {
  const previous = new Map<string, EndpointStat>();
  const horizon = now.getTime() - STAT_CARRY_MAX_DAYS * 24 * 60 * 60_000;
  for (const stat of stored ?? []) {
    if (stat.measuredAt === undefined) continue;
    const at = new Date(stat.measuredAt).getTime();
    if (Number.isNaN(at) || at < horizon) continue;
    previous.set(normalizeProviderName(stat.provider), stat);
  }

  let freshlyMeasured = 0;
  let carriedForward = 0;
  const endpoints = fresh.map((stat) => {
    const hasOwn = MEASUREMENT_FIELDS.some(
      (field) => stat[field] !== undefined,
    );
    if (hasOwn) freshlyMeasured += 1;
    const old = previous.get(normalizeProviderName(stat.provider));
    if (old === undefined) return stat;

    const carried: Partial<
      Pick<EndpointStat, (typeof MEASUREMENT_FIELDS)[number]>
    > = {};
    let carriedAny = false;
    for (const field of MEASUREMENT_FIELDS) {
      if (stat[field] === undefined && old[field] !== undefined) {
        carried[field] = old[field];
        carriedAny = true;
      }
    }
    if (!carriedAny) return stat;
    carriedForward += 1;
    return {
      ...stat,
      ...carried,
      measuredAt: hasOwn ? stat.measuredAt : old.measuredAt,
    };
  });

  return { endpoints, freshlyMeasured, carriedForward };
};

/**
 * The half of a stored pool that may take part in recomputing it.
 *
 * `only` is deliberately dropped. Feeding yesterday's `only` back into the
 * filter that produces today's made the pool a RATCHET: a host absent from the
 * list was excluded as "not in the declared pool", so the list could only ever
 * shrink. Measured 2026-09-02 — a curated list inherited from the deleted
 * profiles had frozen four pools, the worst routing to 4 hosts while 22 passed
 * the policy, and a seven-day quarantine was in practice permanent, since the
 * host dropped out of `only` during it and could never be readmitted.
 *
 * `ignore` and `sort` come through: those are judgments, and the whole point of
 * carrying a judgment across passes is that a measurement should not have to be
 * repeated to keep standing. The measured exclusions recorded in code are
 * unioned in here, because two of them were surviving only as an absence from
 * the frozen list this change removes.
 */
export const poolJudgments = (
  profileKey: string,
  declared: ProviderPool | undefined,
): ProviderPool => {
  const ignore = withMeasuredExclusions(profileKey, declared?.ignore);
  return {
    ...(ignore.length > 0 ? { ignore } : {}),
    ...(declared?.sort === undefined ? {} : { sort: declared.sort }),
  };
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
  /**
   * Operator ceilings, USD per MTok, per ENDPOINT — see `LiveModelState`.
   * Absent means no ceiling. Unlike every other filter here these are set by a
   * person and never derived, which is why they are named for the operator in
   * the exclusion reason: "your cap did this" is a different instruction from
   * "the engine measured this".
   */
  maxInputPricePerMTok?: number;
  maxOutputPricePerMTok?: number;
  /**
   * What a host must be able to DO to serve this model — output cap, context,
   * a proven cache. Derived from the row's `bound_roles` by `requirementsFor`,
   * not typed per model: a capability floor is a property of the work.
   *
   * These YIELD rather than empty a pool. Every other rule here removes a host
   * for something that makes it unfit or unwanted, and a pool emptied by one of
   * those is a model that genuinely has nowhere to run. A capability floor is
   * different: it is a standing rule about future hosts as much as present
   * ones, and a catalogue that reprices or re-caps overnight could otherwise
   * take a role's model down at 00:30 with nobody watching. So when the floors
   * leave nothing standing, they stand down and the caller is told.
   */
  requirements?: PoolRequirements;
}

export interface AllowedPool {
  endpoints: EndpointStat[];
  excluded: { provider: string; reason: string }[];
  /**
   * The capability floors removed every host, so they were not applied. The
   * pool is whatever the other rules left; the model runs on hosts that cannot
   * do the whole job rather than on none at all, and the sync reports it.
   */
  requirementsYielded?: boolean;
}

/**
 * The endpoints a call can actually land on, and WHY each of the others cannot.
 *
 * Order matters, because each endpoint is reported under the first rule that
 * removed it and the first reason is the actionable one: "quarantined" tells an
 * operator to look at an incident, "not in the declared pool" tells them to
 * edit a pool. Quarantine therefore comes before `only`, which the breaker
 * itself relies on — a widened pool skips `only` but never skips a quarantine.
 * The operator's own ceilings sit next, above every measured rule, so a host
 * the operator priced out is reported as priced out rather than as failing
 * something they did not set.
 *
 * The quantization floor is applied ONLY to endpoints that report a
 * quantization. Missing data never excludes anybody: the gateway reports
 * `null` on every endpoint we have looked at, so treating absence as a failure
 * would empty the pool of every gateway-served model at once.
 *
 * The context floor is the one RELATIVE rule, so it runs last, over whatever
 * the absolute ones leave — see `POOL_CONTEXT_SPREAD_RATIO`.
 *
 * The whole chain runs at most TWICE. The capability floors
 * (`input.requirements`) are the only rule allowed to leave a model with no
 * host, and leaving a model with no host is worse than running it on a weak
 * one, so when they do the chain is replayed without them. See
 * `AllowedPoolInput.requirements`.
 */
export const buildAllowedPool = (input: AllowedPoolInput): AllowedPool => {
  const first = filterPool(input, true);
  if (first.endpoints.length > 0 || !first.yieldable) {
    return { endpoints: first.endpoints, excluded: first.excluded };
  }
  const relaxed = filterPool(input, false);
  // If dropping the floors still leaves nothing, the pool was empty for reasons
  // the floors had no part in — report THAT, with its own reasons, rather than
  // blaming a rule that changed nothing.
  if (relaxed.endpoints.length === 0) {
    return { endpoints: relaxed.endpoints, excluded: relaxed.excluded };
  }
  return {
    endpoints: relaxed.endpoints,
    excluded: relaxed.excluded,
    requirementsYielded: true,
  };
};

interface FilterPoolResult extends AllowedPool {
  /** At least one host was removed by a capability floor. */
  yieldable: boolean;
}

const filterPool = (
  input: AllowedPoolInput,
  applyRequirements: boolean,
): FilterPoolResult => {
  const requirements = input.requirements;
  let yieldable = false;
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
    // The operator's own ceilings, before any measured rule: a host priced out
    // was priced out whatever else is true of it, and reporting it under a
    // quantization floor would send someone to look at the wrong thing. The
    // `operator cap:` prefix is load-bearing — it is what the admin table reads
    // to render this as a setting the reader can change rather than a fact.
    if (
      input.maxInputPricePerMTok !== undefined &&
      endpoint.pricing.inputPerMTok > input.maxInputPricePerMTok
    ) {
      excluded.push({
        provider,
        reason: `operator cap: input $${endpoint.pricing.inputPerMTok.toString()}/MTok above $${input.maxInputPricePerMTok.toString()}`,
      });
      continue;
    }
    if (
      input.maxOutputPricePerMTok !== undefined &&
      endpoint.pricing.outputPerMTok > input.maxOutputPricePerMTok
    ) {
      excluded.push({
        provider,
        reason: `operator cap: output $${endpoint.pricing.outputPerMTok.toString()}/MTok above $${input.maxOutputPricePerMTok.toString()}`,
      });
      continue;
    }
    // The capability floors the bound roles imply. The `job floor:` prefix is
    // load-bearing the same way `operator cap:` is — it is how the admin table
    // tells "this host cannot do the work" apart from "somebody excluded it".
    if (applyRequirements && requirements !== undefined) {
      // A host that reports no cap has not declared itself unable; treating
      // silence as failure would empty the pool of every gateway-served model,
      // which reports `null` for this on every endpoint we have looked at.
      if (
        requirements.minMaxOutput !== undefined &&
        endpoint.maxCompletionTokens !== undefined &&
        endpoint.maxCompletionTokens < requirements.minMaxOutput
      ) {
        excluded.push({
          provider,
          reason: `job floor: output cap ${endpoint.maxCompletionTokens.toString()} below ${requirements.minMaxOutput.toString()}`,
        });
        yieldable = true;
        continue;
      }
      if (
        requirements.minContextLength !== undefined &&
        endpoint.contextLength < requirements.minContextLength
      ) {
        excluded.push({
          provider,
          reason: `job floor: context ${endpoint.contextLength.toString()} below ${requirements.minContextLength.toString()}`,
        });
        yieldable = true;
        continue;
      }
      // Only a PROVEN absence of caching excludes. `unknown` passes, for the
      // same reason `hasZdr === undefined` does below: a host nobody has
      // observed has not failed anything, and dropping it would shrink the pool
      // on the strength of missing data — here it would also be
      // self-fulfilling, since a host removed from the pool never gets the
      // traffic that would measure it.
      if (requirements.requireCache === true) {
        const evidence = cacheEvidenceFor(endpoint);
        if (evidence.verdict === "no-cache") {
          excluded.push({
            provider,
            reason: `job floor: no cache (${evidence.source} ${
              evidence.value === undefined
                ? "verdict"
                : evidence.value.toFixed(2)
            })`,
          });
          yieldable = true;
          continue;
        }
      }
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

  // The context floor comes LAST, because it is relative: it needs the pool the
  // other rules leave standing before it can say what "far below the best" is.
  const best = Math.max(0, ...endpoints.map((e) => e.contextLength));
  const cutoff = best * POOL_CONTEXT_SPREAD_RATIO;
  const kept = endpoints.filter((endpoint) => {
    if (endpoint.contextLength >= cutoff) return true;
    excluded.push({
      provider: normalizeProviderName(endpoint.provider),
      reason: `context ${endpoint.contextLength.toString()} is under half the pool's best (${best.toString()}) — it would cap every turn`,
    });
    return false;
  });

  return { endpoints: kept, excluded, yieldable };
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
 * only. Capabilities are read from what the catalogues DECLARE and never from
 * the name: `-mini` and `-flash` are marketing, `tools` and an `image` input
 * modality are claims a transport can be held to. A hand-written TypeScript
 * profile, when one exists, wins over this field by field.
 *
 * It takes the MERGED entry rather than one transport's row, which is what lets
 * a model be described by whichever of its catalogues knows a given fact — the
 * `audio` input modality exists on exactly one of the three, and a profile
 * built from either of the others would have said text-only.
 */
export const deriveDynamicProfile = (
  entry: MergedCatalogueEntry,
  now: Date,
): DynamicProfile => {
  const parameters = new Set(entry.supportedParameters);

  return {
    displayName: entry.name,
    family: entry.owner,
    contextLength: entry.contextWindow ?? 0,
    maxCompletionTokens: entry.maxTokens,
    inputModalities: entry.inputModalities,
    outputModalities: entry.outputModalities,
    supportedParameters: entry.supportedParameters,
    supportsReasoning: parameters.has("reasoning"),
    supportsTools: parameters.has("tools"),
    ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    derivedFrom: {
      // The transports that described it, so an operator reading a promoted
      // model's provenance can tell a single-catalogue guess from a fact two
      // independent sources agreed on.
      source: Object.keys(entry.idsByTransport).sort().join("+"),
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
