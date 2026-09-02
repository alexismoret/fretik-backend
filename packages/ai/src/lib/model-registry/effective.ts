import {
  blendedPricePerMTok,
  cacheShape,
  MARKET_BLENDED_QUARTILES,
} from "@fretik/shared/model-registry/measures";
import { normalizeProviderName } from "@fretik/shared/model-registry/provider-names";
import type {
  CatalogueReasoning,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import {
  getLiveSnapshotSync,
  getLiveStateSync,
} from "@fretik/shared/services/model-registry/live";
import { normalizeFamily } from "./display";
import type {
  CacheStrategy,
  InputModality,
  ModelAssessment,
  ModelCatalogFacts,
  ModelProfile,
  OutputModality,
} from "./types";
import { INPUT_MODALITIES, OUTPUT_MODALITIES, REASONING_LEVELS } from "./types";

/**
 * The registry a running process resolves against: one profile per live row,
 * derived.
 *
 * There is no second layer. Until 2026-08-30 there was — 22 hand-written
 * TypeScript profiles that won EN BLOC over the row for the models they named,
 * while the other 117 models the sync had discovered ran on synthesis alone.
 * That is two answers to the same question, and the measurement was that the
 * derived one was BETTER: `deepseek-v4-pro` had been curated with the ladder
 * `["xhigh","high"]` while the catalogue published `["max","high","low"]`, the
 * `gpt-oss` pair was curated `cache: none` while four hosts publish a read
 * discount, and `deepseek-v4-flash` was curated with no ladder at all when it
 * has three rungs. Curation was not adding knowledge; it was freezing a reading
 * taken on the day someone typed it.
 *
 * So every fact is read, and the two kinds of reading are kept apart:
 *
 *  - what a CATALOGUE publishes — context, modalities, the reasoning contract,
 *    `supported_parameters` — arrives on the row as `dynamicProfile`;
 *  - what a PRICE implies — the cache shape, the cost class — is computed from
 *    `pricing`, so one definition of "expensive" serves the hub and the sync.
 *
 * Nothing is invented. A rung is offered only because the catalogue named it, a
 * ZDR badge lights only because every endpoint said so, and a missing signal
 * answers `undefined` rather than `false` — "we could not check" and "checked,
 * and no" are different claims, and only the second may drive a decision.
 *
 * The one thing still decided rather than read is which rung a model STARTS on;
 * see `reasoningFromContract`.
 */

/**
 * A live row can only be synthesised into a profile once the sync has described
 * the model. `dynamicProfile` is written at discovery from the merged
 * catalogues; a row without one has never been measured, and there is nothing to
 * serve from it — no context to budget against, no price, no ladder. It answers
 * `undefined`, and the boot says so plainly for any model a role depends on.
 */
const describable = (
  live: LiveModelState,
): live is LiveModelState & {
  dynamicProfile: NonNullable<LiveModelState["dynamicProfile"]>;
} => live.dynamicProfile !== null;

/**
 * Catalogue strings are `string[]` on the wire and unions here, so each list is
 * FILTERED against the union's own runtime tuple rather than asserted into it.
 * A modality we do not model yet is dropped, which is the safe direction: an
 * unknown value reaching `prepareModelMessages` would describe a part nobody
 * can build.
 */
const keepKnown = <T extends string>(
  values: readonly string[],
  known: readonly T[],
): T[] => known.filter((candidate) => values.includes(candidate));

/**
 * The published reasoning contract, turned into the two blocks the product
 * steers with: the CATALOG ladder (which rungs the picker may offer) and the
 * ASSESSMENT envelope (which knob the wire carries).
 *
 * This used to return nothing at all. The reasoning was that the catalogues
 * "publish the capability without the ladder" — which was simply wrong, and
 * expensively so: OpenRouter publishes a contract for 271 of its 396 models and
 * the exact ladder for 130 of them, so every promoted model was shipped with
 * its depth control permanently dead. An invented ladder would still be the
 * worse error, and nothing here is invented — a rung is offered only because
 * the catalogue named it, and only if the product models it.
 *
 * Three shapes, matching what curation independently chose for the same models:
 *  - a named ladder ⇒ `effort`, the rungs filtered to the product's own scale;
 *  - a contract with no ladder ⇒ `max-tokens`, the level→budget table steering
 *    it (what `claude-haiku-4.5` and `minimax-m3` were hand-set to);
 *  - no contract ⇒ `none`, and the picker says so rather than showing a dead
 *    control.
 *
 * Which RUNG a model starts on is the one thing here that is a decision rather
 * than a reading, and it is taken by rule — the middle of the ladder — so that a
 * model added by command is defaulted the same way as one added by hand. See
 * `defaultLevel` below for why the middle and not the vendor's own default.
 */
interface SynthesisedReasoning {
  /** The catalog block, absent when the catalogue named no ladder. */
  catalog?: NonNullable<ModelCatalogFacts["reasoning"]>;
  assessment: ModelAssessment["reasoning"];
}

const reasoningFromContract = (
  contract: CatalogueReasoning | undefined,
): SynthesisedReasoning => {
  if (contract === undefined) {
    return { assessment: { style: "none", defaultLevel: "none" } };
  }
  // Ordered by the PRODUCT's own scale rather than the catalogue's, so "the
  // cheapest rung" means the same thing whichever order an upstream lists.
  const efforts = REASONING_LEVELS.filter((level) =>
    (contract.supportedEfforts ?? []).includes(level),
  );
  if (efforts.length === 0) {
    // A budget rather than a ladder. `low` because an unmeasured model's
    // thinking allowance is a cost the team did not ask for — the shared
    // level→budget table bounds it, and a team can raise it per turn.
    return { assessment: { style: "max-tokens", defaultLevel: "low" } };
  }
  // THE MIDDLE RUNG — upper of the two when the ladder is even.
  //
  // Not the upstream's own default, and that is deliberate. A vendor's default
  // is tuned for the vendor's benchmark, and ours ranged from `medium` on a
  // model curation had pinned to `low` to `medium` on one curation had pinned
  // to `xhigh`: it tracks nothing we care about, and 11 of 22 curated profiles
  // had already overridden it by hand.
  //
  // Hand-overriding is exactly what an automatic registry cannot keep doing. A
  // model promoted by `models:admin promote` gets no hand-tuning, so a rule
  // that only curated models benefit from is a rule that quietly serves the
  // fleet two different ways — the incoherence this whole engine is removing.
  //
  // The middle is the defensible automatic answer: it commits to neither end of
  // a ladder whose rungs mean different things per vendor, and it scales with
  // how much range the model actually offers — a two-rung model lands high, a
  // six-rung model lands mid. `Math.floor(n / 2)` is that rule exactly, since
  // `efforts` is ascending; on an even ladder it takes the upper of the two,
  // because a default that under-thinks reads as a worse model while one that
  // over-thinks reads as a slower one, and only the second is visibly a choice.
  const defaultLevel = efforts[Math.floor(efforts.length / 2)] ?? "low";
  return {
    catalog: { mandatory: contract.mandatory, supportedEfforts: efforts },
    assessment: { style: "effort", defaultLevel },
  };
};

/**
 * Blended price → cost class, on the market's own quartiles
 * (`MARKET_BLENDED_QUARTILES`). Deriving it here rather than storing it keeps
 * one definition of "expensive"; importing the boundaries rather than restating
 * them keeps that definition the same as the sync's.
 */
const costClassFor = (blendedPerMTok: number) =>
  blendedPerMTok >= MARKET_BLENDED_QUARTILES.p75
    ? "premium"
    : blendedPerMTok < MARKET_BLENDED_QUARTILES.p25
      ? "budget"
      : "standard";

/**
 * A profile for a model the code has never met, from its live row alone.
 *
 * PURE: no clock, no database, no network — so every default below is
 * assertable in a test with an empty environment.
 */
/**
 * The one PDF dialect every native-file call site produces, and the only value
 * the 13 curated profiles that enable it ever carry.
 */
const NATIVE_PDF_MIME_TYPES = ["application/pdf"];

/**
 * The pricing shape, in the vocabulary the profile still speaks.
 *
 * `CacheShape` answers how a vendor CHARGES; `CacheStrategy` was one field
 * trying to answer that and "must the caller place `cache_control` markers?" at
 * once. Only the charging half is a pricing fact, so only it is derived here —
 * the marker question is a dialect fact and `openrouter-cache.ts` answers it
 * from the model id, for curated and synthesised profiles alike.
 *
 * So every shape that discounts reads maps to `implicit`: from this field's one
 * remaining reader — the cost model — that is exactly what a premium, a storage
 * rate and free writes have in common, and the premium itself is billed from
 * the prices rather than from this label.
 */
const cacheStrategyFor = (pricing: LiveModelState["pricing"]): CacheStrategy =>
  cacheShape(pricing) === "none" ? "none" : "implicit";

/**
 * Whether the request should DEMAND zero retention, read off the routes it can
 * actually reach.
 *
 * Two things this is not. It is not a badge — a model's retention story is told
 * by `disabledReason: "no-zdr"` and by the endpoint table — and it is not a
 * survey of every host the catalogues mention. It is one wire flag whose whole
 * effect is to make the PLATFORM narrow routing to zero-retention routes.
 *
 * That reframing decides both halves of the rule:
 *
 * 1. **Read the vetted pool, not every endpoint.** A host the pool already
 *    excludes cannot serve the call, so letting its stance decide the flag lets
 *    an unreachable route disarm the protection for the reachable ones.
 * 2. **One reachable zero-retention route is enough to demand it.** The old
 *    `every` meant a single non-ZDR host silently dropped the demand for the
 *    whole model — the failure mode being that routing was then free to land
 *    anywhere, which is exactly what the flag exists to prevent. `some` costs
 *    routing breadth (the platform narrows to the ZDR routes) and that is the
 *    correct trade when the policy requires zero retention. `false` is kept for
 *    the case where every reachable route is KNOWN not to be zero-retention:
 *    demanding it there empties the pool and 404s every call.
 *
 * Why this is not merely defensive: the pool names HOSTS while retention is a
 * property of ROUTES, and one host commonly serves both kinds. Measured
 * 2026-09-02 across the fleet's dual-served models, 20 hosts are split —
 * `claude-sonnet-5` reaches `google-vertex` by three routes of which one is
 * zero-retention, `gemini-3.5-flash-lite` by five of which one. `only:
 * ["vertex"]` cannot express that difference; this flag is the only thing that
 * can, which is why it must not be dropped on a technicality.
 */
const zdrStanceFor = (live: LiveModelState): boolean | undefined => {
  const vetted = new Set(
    (live.providerPool[live.transport]?.only ?? []).map(normalizeProviderName),
  );
  const inPool = live.endpointStats.filter((endpoint) =>
    vetted.has(normalizeProviderName(endpoint.provider)),
  );
  // An empty intersection means the pool names hosts no endpoint answers to —
  // a hand-written list whose spellings drifted, which the audit reports and
  // nothing here can fix. Reading every endpoint then is the safe reading: it
  // is what the pool would have been, not silence.
  const reachable = inPool.length === 0 ? live.endpointStats : inPool;
  const stances = reachable
    .map((endpoint) => endpoint.hasZdr)
    .filter((stance): stance is boolean => stance !== undefined);
  return stances.length === 0 ? undefined : stances.some(Boolean);
};

/**
 * Whether `max_tokens` must be left off the wire.
 *
 * Sending a parameter the pool does not advertise empties the pool — a 404 "no
 * endpoints found matching your data policy" — rather than dropping the field,
 * which is why this is not merely cosmetic. The curated profiles carry it on
 * every hosted OpenAI model because their ZDR route is Azure, which advertises
 * `max_completion_tokens` instead. That is not OpenAI knowledge: it is exactly
 * what the endpoints say, and reading them agrees with all four hand-written
 * flags (measured 2026-08-30).
 */
const omitMaxTokensFor = (live: LiveModelState): boolean =>
  live.endpointStats.length > 0 &&
  live.endpointStats.every(
    (endpoint) => !endpoint.supportedParameters.includes("max_tokens"),
  );

/**
 * The vetted pool for the transport this row routes through, in the profile's
 * vocabulary.
 *
 * Per-transport rather than merged, because host names are not portable: a pool
 * measured on OpenRouter names OpenRouter's slugs, and applying them to the
 * gateway would either exclude nothing or exclude everything.
 */
const poolFor = (
  live: LiveModelState,
): Pick<ModelAssessment["provider"], "only" | "order" | "ignore" | "sort"> => {
  const pool = live.providerPool[live.transport];
  if (pool === undefined) return {};
  return {
    ...(pool.only === undefined ? {} : { only: pool.only }),
    ...(pool.order === undefined ? {} : { order: pool.order }),
    ...(pool.ignore === undefined ? {} : { ignore: pool.ignore }),
    ...(pool.sort === undefined ? {} : { sort: pool.sort }),
  };
};

/**
 * Serving precisions a small model keeps its format discipline at.
 *
 * `"unknown"` is IN the list and that is not an oversight: measured 2026-08 on
 * gpt-oss-120b's 19 endpoints, Groq — the fastest upstream in the pool — reports
 * `unknown`, so excluding unreported precisions would drop the good host and
 * keep the quantized ones. It is a passenger, though, not a passport: see
 * `quantizationsFor`.
 */
const QUANTIZATION_FLOOR = ["bf16", "fp16", "unknown"] as const;

/** The precisions that are an actual claim, as opposed to an absence of one. */
const REPORTED_GOOD = new Set(["bf16", "fp16"]);

/**
 * Whether a quantization floor MEANS anything for this model.
 *
 * The floor is a real guard where it applies: of the 14 hosts in
 * `gpt-oss-120b`'s pool six serve it at fp4 or fp8, and filtering them out
 * leaves akashml (bf16), DeepInfra (bf16) and Cerebras (fp16) standing. It is
 * also what once took three memory roles down — applied to `deepseek-v4-flash`
 * it emptied the pool outright (160/160 calls, "No endpoints found for the
 * request with quantization", 2026-08-03).
 *
 * The old exemption avoided that by sparing any model that "governs its own
 * serving", tested as `order || only`. That worked only while `only` meant a
 * hand-vetted list; the sync computes one for every model now, so the test had
 * quietly become "always exempt" and the guard was being lost on exactly the
 * model it was written for.
 *
 * THE CONDITION IS NOT "does anything survive". That was the first replacement
 * written here and it was wrong, in a way the data makes obvious.
 * `deepseek-v4-flash`'s four hosts are DeepInfra fp8, BaseTen fp8, Venice
 * unreported, Fireworks unreported — so something survives, and what survives is
 * only the hosts that declare nothing. The filter would drop the two whose
 * precision we KNOW and keep the two we do not: a filter on disclosure rather
 * than on quality, costing the pool its fastest member (BaseTen, 283 tok/s
 * against DeepInfra's 67 on the same generation) for no measured gain.
 *
 * So the floor is sent only when a host with a REPORTED good precision survives
 * it. `unknown` may ride along beside a bf16 host; it may not be the only thing
 * left, because then the filter has selected for silence.
 */
const quantizationsFor = (
  live: LiveModelState,
): readonly string[] | undefined => {
  const anchored = live.endpointStats.some((endpoint) =>
    REPORTED_GOOD.has((endpoint.quantization ?? "").toLowerCase()),
  );
  return anchored ? QUANTIZATION_FLOOR : undefined;
};

export const synthesizeProfileFromLive = (
  live: LiveModelState,
): ModelProfile | undefined => {
  if (!describable(live)) return undefined;
  const dynamic = live.dynamicProfile;
  const inputModalities = keepKnown<InputModality>(
    dynamic.inputModalities,
    INPUT_MODALITIES,
  );
  const blended = blendedPricePerMTok(live.pricing);
  const reasoning = reasoningFromContract(dynamic.reasoning);
  const zdrStance = zdrStanceFor(live);
  const omitMaxTokens = omitMaxTokensFor(live);
  const quantizations = quantizationsFor(live);

  return {
    key: live.profileKey,
    // The catalogue's author, folded onto a known family where one matches so
    // a synthesised model gets the same icon and colour as its curated
    // siblings, and a deterministic fallback where none does.
    family: normalizeFamily(dynamic.family),
    catalog: {
      // The id on the transport the row currently routes through — never
      // another transport's spelling of the same model.
      id: live.modelIds[live.transport] ?? live.profileKey,
      // The EFFECTIVE context, not the headline: the smallest any allowed
      // endpoint offers, minus the safety margin. Budgeting against the
      // headline overflows the moment a turn lands on the smallest host.
      contextLength: live.effectiveContextLength,
      ...(live.effectiveMaxOutput === null
        ? {}
        : { maxCompletionTokens: live.effectiveMaxOutput }),
      inputModalities,
      outputModalities: keepKnown<OutputModality>(
        dynamic.outputModalities,
        OUTPUT_MODALITIES,
      ),
      // Passed through verbatim: `SupportedParameter` is an OPEN union, so a
      // parameter nobody has modelled is still a parameter the pool filter and
      // `require_parameters` need to see.
      supportedParameters: dynamic.supportedParameters,
      // The PUBLISHED ladder, never an invented one — see
      // `reasoningFromContract`. Absent when the catalogue named none, which is
      // the case the old blanket refusal was right about: offering the picker a
      // rung the upstream rejects turns `require_parameters` into an empty pool
      // rather than a dropped field.
      ...(reasoning.catalog === undefined
        ? {}
        : { reasoning: reasoning.catalog }),
    },
    assessment: {
      costClass: costClassFor(blended),
      ...(live.aaMetrics?.slug === undefined
        ? {}
        : { aaSlug: live.aaMetrics.slug }),
      // The pool median the sync computed for THIS transport, which is the
      // number the budget cap and the credit multiplier already use.
      pricing: {
        inputPerMTok: live.pricing.inputPerMTok,
        outputPerMTok: live.pricing.outputPerMTok,
        ...(live.pricing.cacheReadPerMTok === undefined
          ? {}
          : { cacheReadPerMTok: live.pricing.cacheReadPerMTok }),
      },
      // Images and PDFs both ride natively when the catalogue says the model
      // takes them. `file` WAS held back as family knowledge no catalogue
      // publishes — measured 2026-08-30 against the 22 curated profiles, the
      // `file` modality and the hand-written activation agree on all 22, so it
      // was a published fact all along. `video` and `audio` stay off because no
      // call site produces parts for them, which is a fact about US.
      nativeInput: {
        image: inputModalities.includes("image"),
        video: false,
        fileMimeTypes: inputModalities.includes("file")
          ? NATIVE_PDF_MIME_TYPES
          : [],
        audio: false,
      },
      // Read off the PRICES rather than declared. The old blanket `"none"` was
      // the safe half of a bad trade: it never granted an unearned discount,
      // and it over-reported the cost of every model that does cache — which is
      // most of them, and by up to 2.5× on the term that dominates a turn.
      cache: { strategy: cacheStrategyFor(live.pricing) },
      // Derived from the same published contract as the catalog block above,
      // so the wire style and the offered ladder can never disagree. `none`
      // when the catalogue described no reasoning at all — the picker then
      // shows no depth control rather than a dead one.
      reasoning: reasoning.assessment,
      // The routing envelope, read off the row's vetted pool FOR THE TRANSPORT
      // THIS MODEL ROUTES THROUGH — never another transport's, whose host names
      // are a different vocabulary.
      //
      // This is what carries a measured exclusion to the wire. `ignore` and
      // `order` are judgments (`ignore: ["fireworks"]` exists because Fireworks
      // was measured returning degraded output); `only` and `sort` are computed
      // nightly from endpoints that answered. Both halves live on the row, and
      // the sync carries the judgments forward across passes rather than
      // recomputing them.
      //
      // Zero retention is read the same way, from the endpoints: it used to be
      // hardcoded `true`, so every promoted model displayed a ZDR badge no
      // matter what its routes said. A stance nobody could check is not a
      // floor, it is a claim, and this one reached the UI.
      provider: {
        ...poolFor(live),
        ...(quantizations === undefined ? {} : { quantizations }),
        ...(zdrStance === undefined ? {} : { zdr: zdrStance }),
        ...(omitMaxTokens ? { omitMaxTokens: true } : {}),
      },
      // The live row owns enablement — this half of the registry has no
      // opinion, and `resolveEnabled` ANDs the two anyway.
      enabled: live.enabled,
      ...(live.disabledReason === null
        ? {}
        : { disabledReason: disabledReasonFor(live.disabledReason) }),
    },
  };
};

/**
 * `DisabledReason` carries one value the profile vocabulary does not:
 * `"policy"`, written when a model fails its own published-model policy. It
 * maps onto `unavailable`, which is what it means to a team — the model cannot
 * be served — rather than being dropped, which would leave a disabled model
 * with no tooltip at all.
 */
const disabledReasonFor = (
  reason: NonNullable<LiveModelState["disabledReason"]>,
): "cost" | "no-zdr" | "unavailable" =>
  reason === "policy" ? "unavailable" : reason;

/**
 * Synthesised profiles, memoised per snapshot.
 *
 * Cleared through the SAME path that drops memoised model instances
 * (`clearResolvedModelCache`, itself wired to `onLiveRegistryChange`), so there
 * is no second subscription to keep in step — one invalidation path, one set of
 * things it invalidates.
 */
const synthesised = new Map<string, ModelProfile | undefined>();

export const clearSynthesisedProfileCache = (): void => {
  synthesised.clear();
};

const synthesiseCached = (live: LiveModelState): ModelProfile | undefined => {
  const hit = synthesised.get(live.profileKey);
  if (hit !== undefined || synthesised.has(live.profileKey)) return hit;
  const built = synthesizeProfileFromLive(live);
  synthesised.set(live.profileKey, built);
  return built;
};

/**
 * The profile for a key, or `undefined` when no row describes it.
 *
 * A cold snapshot answers `undefined` for everything, which is honest: with no
 * row there is no context length to budget against, no price to bill, no pool to
 * route through and no ladder to offer. The previous behaviour — falling back to
 * a TypeScript registry — looked like resilience and was in fact a second
 * registry with its own, staler answers.
 */
export const getEffectiveProfile = (key: string): ModelProfile | undefined => {
  const live = getLiveStateSync(key);
  return live === undefined ? undefined : synthesiseCached(live);
};

export const getEffectiveProfileOrThrow = (key: string): ModelProfile => {
  const profile = getEffectiveProfile(key);
  if (profile === undefined) {
    throw new Error(
      `No model profile for key "${key}" — no live row describes it. ` +
        `Run \`bun run models:sync\` (jobs package) if this is a fresh database.`,
    );
  }
  return profile;
};

/** Every model a team could be offered: one per live row the sync has described. */
export const listEffectiveProfiles = (): readonly ModelProfile[] => {
  const profiles: ModelProfile[] = [];
  for (const live of getLiveSnapshotSync()?.values() ?? []) {
    const profile = synthesiseCached(live);
    if (profile !== undefined) profiles.push(profile);
  }
  return profiles;
};
