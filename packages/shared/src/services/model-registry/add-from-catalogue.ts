import { modelKeyForId } from "../../model-registry/keys";
import { DEFAULT_CANDIDATE_POLICY } from "../../model-registry/policy";
import type { AddFromCatalogueOutcome } from "../../model-registry/types";
import { addCatalogueModel } from "./admin";
import { readLiveStateRow } from "./live";
import {
  buildAllowedPool,
  computeEffectiveContext,
  computePoolPricing,
  deriveDynamicProfile,
} from "./sync/compute";
import { fetchGatewayCatalog } from "./sync/sources/gateway-catalog";
import { fetchGatewayEndpoints } from "./sync/sources/gateway-endpoints";

/**
 * Add a model by its catalogue id, as a CANDIDATE.
 *
 * Discovery is automatic and publication is not, so this never publishes: a
 * candidate is invisible to teams, nothing routes to it, and `promote` is the
 * deliberate second step. Day-zero endpoints are measurably unstable — one
 * model's tool-calling accuracy spanned 22 % to 37 % depending on the host —
 * so a person looks at the scorecard first.
 *
 * The four refusals live here rather than in a caller because three of them
 * are catalogue logic: whether the id exists, whether the entry is a language
 * model, and whether anything it serves survives the discovery policy.
 * `addCatalogueModel` has no catalogue and can answer none of them.
 *
 * Two network calls, uncached and sequential (the full catalogue, then this
 * model's endpoints). An interactive surface should split "search" from
 * "confirm" rather than making someone wait through both blind.
 */
export const addFromCatalogue = async (input: {
  modelId: string;
  profileKey?: string;
  now: Date;
}): Promise<AddFromCatalogueOutcome> => {
  const catalog = await fetchGatewayCatalog();
  const entry = catalog.find((candidate) => candidate.id === input.modelId);
  if (entry === undefined) {
    const tail = input.modelId.split("/").at(-1) ?? input.modelId;
    return {
      kind: "not-in-catalogue",
      catalogueSize: catalog.length,
      near: catalog
        .filter((candidate) => candidate.id.includes(tail))
        .slice(0, 8)
        .map((candidate) => candidate.id),
    };
  }

  // Only a DECLARED `false` refuses. `undefined` means the catalogue does not
  // classify — two of the three do not — and rejecting the unclassified would
  // make most of the market unaddable by hand. An embedding model that slips
  // through is caught by the pool check below: it advertises no `tools`.
  if (entry.isLanguageModel === false) return { kind: "not-a-language-model" };

  const profileKey = input.profileKey ?? modelKeyForId(entry.id);
  const existing = await readLiveStateRow(profileKey);
  if (existing !== undefined) {
    return {
      kind: "key-exists",
      profileKey,
      status: existing.status,
      modelIds: Object.values(existing.modelIds),
    };
  }

  const endpoints = await fetchGatewayEndpoints(entry.id);
  const pool = buildAllowedPool({
    poolWidened: false,
    quarantined: [],
    endpoints,
    requireTools: DEFAULT_CANDIDATE_POLICY.toolCallingRequired,
    requireZdr: DEFAULT_CANDIDATE_POLICY.zdrRequired,
    ...(DEFAULT_CANDIDATE_POLICY.quantizationFloor === undefined
      ? {}
      : { quantizationFloor: DEFAULT_CANDIDATE_POLICY.quantizationFloor }),
  });
  if (pool.endpoints.length === 0) {
    return {
      kind: "no-eligible-endpoint",
      endpointCount: endpoints.length,
      excluded: pool.excluded,
    };
  }

  const context = computeEffectiveContext(pool.endpoints);
  await addCatalogueModel({
    profileKey,
    transport: "gateway",
    modelIds: { gateway: entry.id },
    dynamicProfile: deriveDynamicProfile(
      { ...entry, idsByTransport: { gateway: entry.id } },
      input.now,
    ),
    effectiveContextLength: context.contextLength,
    ...(context.maxOutput === null
      ? {}
      : { effectiveMaxOutput: context.maxOutput }),
    pricing: computePoolPricing(pool.endpoints),
  });

  // Read back rather than trust the insert: `addCatalogueModel` swallows a key
  // collision, so a concurrent add of the same model leaves one insert and one
  // caller with nothing — far likelier from a clickable surface than from a
  // shell, and worth saying plainly rather than alarmingly.
  const state = await readLiveStateRow(profileKey);
  if (state === undefined) return { kind: "insert-lost-race", profileKey };

  return {
    kind: "added",
    profileKey,
    state,
    endpoints: pool.endpoints,
    excluded: pool.excluded,
  };
};
