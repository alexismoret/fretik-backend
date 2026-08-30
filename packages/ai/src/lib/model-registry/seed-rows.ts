import { normalizeProviderList } from "@fretik/shared/model-registry/provider-names";
import type {
  ProviderPoolByTransport,
  TransportId,
} from "@fretik/shared/model-registry/types";
import type { LiveStateSeed } from "@fretik/shared/services/model-registry/seed";
import { seedLiveState } from "@fretik/shared/services/model-registry/seed";
import { CONTEXT_SAFETY_MARGIN_TOKENS } from "@fretik/shared/services/model-registry/sync/compute";
import { modelIdsForProfile } from "./gateway-ids";
import { MODEL_PROFILES, ROLE_BINDINGS } from "./profiles";
import type { ModelProfile } from "./types";

/**
 * Turning the curated registry into live-state rows.
 *
 * This is the one place the two layers meet. Everything here is derived from a
 * profile — no judgement, no table to maintain — so a profile added in a pull
 * request becomes a routable row on the next boot, and the nightly sync takes
 * over from there.
 */

/** Which internal roles point at each profile, so the sync knows what depends on it. */
const boundRolesByProfile = (): ReadonlyMap<string, string[]> => {
  const byProfile = new Map<string, string[]>();
  for (const [role, binding] of Object.entries(ROLE_BINDINGS)) {
    const existing = byProfile.get(binding.profileKey) ?? [];
    existing.push(role);
    byProfile.set(binding.profileKey, existing);
  }
  return byProfile;
};

/**
 * The vetted pool, per transport.
 *
 * The profile's pool was written against OpenRouter's spelling of provider
 * names, so it is normalised and then INTERSECTED with what the other transport
 * actually serves — a member that does not exist there is not a pool member
 * there. Measured 2026-08-29: the four-host DeepSeek pool has three of its
 * members on the gateway (`venice` is absent), and the gateway's own catalogue
 * for that model additionally offers hosts we have measured as unusable, which
 * is exactly why the pool is carried across rather than dropped.
 */
const poolFor = (
  profile: ModelProfile,
  transports: Partial<Record<TransportId, string>>,
): ProviderPoolByTransport => {
  const { only, order, ignore } = profile.assessment.provider;
  if (!only && !order && !ignore) return {};
  const pool = {
    ...(only ? { only: normalizeProviderList(only) } : {}),
    ...(order ? { order: normalizeProviderList(order) } : {}),
    ...(ignore ? { ignore: normalizeProviderList(ignore) } : {}),
  };
  const byTransport: ProviderPoolByTransport = {};
  for (const transport of Object.keys(transports)) {
    if (transport === "gateway" || transport === "openrouter")
      byTransport[transport] = { ...pool };
  }
  return byTransport;
};

/**
 * The transport a profile STARTS on — which is the one it was measured on.
 *
 * The gateway is where the fleet is going, and for good reasons: no markup and
 * no platform fee against 5.5 % on credit purchases, zero-retention per request
 * at no cost, cache markers placed upstream, provider health folded into
 * routing, a first-party SDK provider. None of that is in question.
 *
 * What is in question is one wire detail that no catalogue can answer: whether
 * the unified reasoning parameter is honoured. Every gateway endpoint ADVERTISES
 * `reasoning` in its `supported_parameters` (checked across six unrelated
 * families), which is good evidence, and evidence is not measurement. Two models
 * in this fleet carry hand-measured thinking budgets — one exists because the
 * model once spent 38 679 reasoning tokens in a single step — and a budget
 * silently dropped is a cost and latency regression with no symptom to trace.
 *
 * So the seed starts every model where it already works, and
 * `bun run models:check -- --gateway-probe --apply` moves them: it measures the
 * tool round-trip, zero-retention acceptance, reasoning responsiveness and the
 * cost metadata per model, and flips the ones that pass. One command for the
 * whole fleet, and each flip is a fact rather than a hope. A model the gateway
 * alone serves starts there because there is nowhere else to start it.
 */
const startingTransport = (
  ids: Partial<Record<TransportId, string>>,
): TransportId => (ids.openrouter === undefined ? "gateway" : "openrouter");

export const buildLiveStateSeeds = (): LiveStateSeed[] => {
  const roles = boundRolesByProfile();
  const seeds: LiveStateSeed[] = [];
  for (const profile of Object.values(MODEL_PROFILES)) {
    const modelIds = modelIdsForProfile(profile.key);
    if (Object.keys(modelIds).length === 0) continue;
    seeds.push({
      profileKey: profile.key,
      transport: startingTransport(modelIds),
      enabled: profile.assessment.enabled,
      ...(profile.assessment.disabledReason
        ? { disabledReason: profile.assessment.disabledReason }
        : {}),
      modelIds,
      providerPool: poolFor(profile, modelIds),
      // A starting value only. The first sync replaces it with the MINIMUM
      // across the pool's endpoints, which is the number that actually bounds a
      // request — endpoints for one model span 262 144 to 1 048 576 tokens.
      effectiveContextLength: Math.max(
        0,
        profile.catalog.contextLength - CONTEXT_SAFETY_MARGIN_TOKENS,
      ),
      ...(profile.catalog.maxCompletionTokens !== undefined
        ? { effectiveMaxOutput: profile.catalog.maxCompletionTokens }
        : {}),
      pricing: {
        inputPerMTok: profile.assessment.pricing.inputPerMTok,
        outputPerMTok: profile.assessment.pricing.outputPerMTok,
        ...(profile.assessment.pricing.cacheReadPerMTok !== undefined
          ? { cacheReadPerMTok: profile.assessment.pricing.cacheReadPerMTok }
          : {}),
      },
      boundRoles: roles.get(profile.key) ?? [],
      // Carries curation's answer to "which effort level does AA grade here?"
      // into the sync, which cannot import profiles.
      ...(profile.assessment.aaSlug === undefined
        ? {}
        : { aaSlug: profile.assessment.aaSlug }),
    });
  }
  return seeds;
};

/**
 * Write the seeds. Idempotent, and deliberately narrow on a re-run: only the
 * curation-owned fields are refreshed, so a boot never undoes a decision the
 * engine took at three in the morning. See `seedLiveState` for the field-by-field
 * rule.
 */
export const seedModelRegistry = async (): Promise<{
  inserted: number;
  refreshed: number;
}> => seedLiveState(buildLiveStateSeeds());
