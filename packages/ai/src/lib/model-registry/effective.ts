import {
  blendedPricePerMTok,
  MARKET_BLENDED_QUARTILES,
} from "@fretik/shared/model-registry/measures";
import type { LiveModelState } from "@fretik/shared/model-registry/types";
import {
  getLiveSnapshotSync,
  getLiveStateSync,
} from "@fretik/shared/services/model-registry/live";
import { normalizeFamily } from "./display";
import { MODEL_PROFILES } from "./profiles";
import type { InputModality, ModelProfile, OutputModality } from "./types";
import { INPUT_MODALITIES, OUTPUT_MODALITIES } from "./types";

/**
 * The registry a running process actually resolves against: curated profiles,
 * plus a profile SYNTHESISED for every model that has a live row and no
 * hand-written one.
 *
 * This is what makes promotion mean something. `promote` writes a row, and
 * until now nothing read it: `getProfile` threw on any key outside
 * `MODEL_PROFILES`, `dynamicProfile` was written by the sync and consumed
 * nowhere, and a promoted model was therefore invisible to the picker, to the
 * hub and to every team — measured on 2026-08-30, 110 candidate rows that no
 * amount of promoting could surface. A curated profile takes a release; a live
 * row takes a write. Both must produce a usable model.
 *
 * **The curated profile wins EN BLOC, never field by field.** A merge would be
 * worse than either source alone: the hand-written half of a profile is a set
 * of decisions that hold TOGETHER — a reasoning style that assumes a particular
 * effort ladder, a cache strategy that assumes the pool routing to a host that
 * caches, a `nativeInput` policy sized against a context. Letting a nightly
 * sync overwrite one of them leaves a profile nobody designed. So a key present
 * in `MODEL_PROFILES` is served from there and the live row governs only what
 * it already governed: routing, pool, quarantines, enablement.
 *
 * Synthesis is deliberately CONSERVATIVE. Every default below answers the same
 * question — what is safe to assume about a model nobody has looked at? — and
 * the answer is always the option that fails visibly rather than silently.
 */

/**
 * A live row can only be synthesised into a profile once the sync has described
 * the model. `dynamicProfile` is written at discovery from the merged
 * catalogues; a row without one is a seeded curated model whose profile lives
 * in TypeScript anyway.
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
      // Deliberately NO `reasoning` block, even for a model whose parameters
      // advertise `reasoning`. The block is a CONTRACT — which efforts exist,
      // whether reasoning can be turned off — and the catalogues publish the
      // capability without the ladder. An invented ladder offers the picker
      // rungs the upstream may reject, and `require_parameters` turns a
      // rejected rung into an empty pool rather than a dropped field.
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
      // Images ride natively when the catalogue says the model takes them —
      // that is a published fact and the tool-mediated path is the fallback.
      // The others stay OFF: `file` means PDF, and which PDF dialect an
      // upstream truly accepts is family knowledge no catalogue publishes;
      // `video` and `audio` have no call site producing parts for them.
      nativeInput: {
        image: inputModalities.includes("image"),
        video: false,
        fileMimeTypes: [],
        audio: false,
      },
      // No caching claimed. `explicit-breakpoints` would place markers an
      // upstream may not honour, and `implicit` would tell the cost model to
      // apply a discount nobody granted — the second is the dangerous one,
      // because it under-reports what the model costs.
      cache: { strategy: "none" },
      // No reasoning parameter is sent at all. This is the same decision as
      // the missing catalog block, seen from the product side: with no ladder
      // there is no level to offer, so the picker shows no depth control
      // rather than a dead one.
      reasoning: { style: "none", defaultLevel: "none" },
      // Both non-negotiable for a model nobody vetted: `requireParameters`
      // stops a host silently dropping `tools`, and zero retention is the
      // floor the discovery policy already held this model to.
      provider: { requireParameters: true, zdr: true },
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
 * The profile for a key, curated or synthesised, or `undefined` when neither
 * layer knows it.
 *
 * A cold snapshot answers with the TypeScript registry alone, which is exactly
 * what a replica that cannot reach the database should serve.
 */
export const getEffectiveProfile = (key: string): ModelProfile | undefined => {
  const curated = MODEL_PROFILES[key];
  if (curated !== undefined) return curated;
  const live = getLiveStateSync(key);
  return live === undefined ? undefined : synthesiseCached(live);
};

export const getEffectiveProfileOrThrow = (key: string): ModelProfile => {
  const profile = getEffectiveProfile(key);
  if (profile === undefined) {
    throw new Error(`Unknown model profile key: "${key}"`);
  }
  return profile;
};

/**
 * Every profile a team could be offered: the curated registry, plus every live
 * row that describes a model it does not already contain.
 *
 * Curated first and deduplicated by key, so a model with both keeps its
 * hand-written profile — the same rule `getEffectiveProfile` applies, stated
 * once more here because a list built the other way round would quietly serve
 * the synthesised twin.
 */
export const listEffectiveProfiles = (): readonly ModelProfile[] => {
  const profiles = [...Object.values(MODEL_PROFILES)];
  const seen = new Set(profiles.map((profile) => profile.key));
  for (const live of getLiveSnapshotSync()?.values() ?? []) {
    if (seen.has(live.profileKey)) continue;
    const synthesisedProfile = synthesiseCached(live);
    if (synthesisedProfile !== undefined) profiles.push(synthesisedProfile);
  }
  return profiles;
};
