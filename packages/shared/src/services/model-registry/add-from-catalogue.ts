import {
  catalogueMatchKey,
  mergeCatalogues,
} from "../../model-registry/catalogue";
import { modelKeyForId } from "../../model-registry/keys";
import { DEFAULT_CANDIDATE_POLICY } from "../../model-registry/policy";
import type {
  AddFromCatalogueOutcome,
  TransportId,
} from "../../model-registry/types";
import { addCatalogueModel } from "./admin";
import { readLiveStateRow } from "./live";
import {
  buildAllowedPool,
  computeEffectiveContext,
  computePoolPricing,
  deriveDynamicProfile,
} from "./sync/compute";
import { createCatalogueSources, sourceForTransport } from "./sync/sources";

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
 * EVERY catalogue is consulted, not just the gateway's (2026-09-01). Reading
 * one made this the second half of a bootstrap dead end: a fresh environment
 * needs rows for keys like `deepseek-v4-flash`, which no catalogue derives
 * (`modelKeyForId` produces `deepseek-deepseek-v4-flash-0731`), so they have to
 * be added by hand with an explicit key — and for a model served only by
 * OpenRouter this refused, because it was looking in the wrong catalogue. The
 * only path left was copying rows between databases in SQL. Merging the
 * catalogues also means the row is born knowing every transport that serves it,
 * so switching it later is one write rather than a lookup by hand.
 *
 * Two network rounds, uncached (all catalogues in parallel, then this model's
 * endpoints). An interactive surface should split "search" from "confirm"
 * rather than making someone wait through both blind.
 */
export const addFromCatalogue = async (input: {
  modelId: string;
  profileKey?: string;
  /** Force a starting transport. Defaults to the first source that serves it. */
  transport?: TransportId;
  now: Date;
}): Promise<AddFromCatalogueOutcome> => {
  const sources = createCatalogueSources();
  const listings = (
    await Promise.all(
      sources.map(async (source) => {
        try {
          return { source, entries: await source.listModels() };
        } catch {
          // One unreadable catalogue must not make a model served by another
          // unaddable. The refusal below still names how much we could see.
          return undefined;
        }
      }),
    )
  ).filter((listing) => listing !== undefined);

  const catalog = mergeCatalogues(listings);
  // Matched on the id as spelled by ANY transport, because the caller is
  // holding one spelling and has no way to know which catalogue it came from.
  const entry = catalog.find((candidate) =>
    Object.values(candidate.idsByTransport).includes(input.modelId),
  );
  if (entry === undefined) {
    const wanted = catalogueMatchKey(input.modelId);
    return {
      kind: "not-in-catalogue",
      catalogueSize: catalog.length,
      near: catalog
        .filter((candidate) => catalogueMatchKey(candidate.id).includes(wanted))
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

  // The requested transport when it serves this model, else the first source
  // that does — registry order, the same rule discovery follows.
  const transport =
    input.transport !== undefined &&
    entry.idsByTransport[input.transport] !== undefined
      ? input.transport
      : sources.find((source) => entry.idsByTransport[source.id] !== undefined)
          ?.id;
  const transportId =
    transport === undefined ? undefined : entry.idsByTransport[transport];
  if (transport === undefined || transportId === undefined) {
    return { kind: "no-eligible-endpoint", endpointCount: 0, excluded: [] };
  }

  const source = sourceForTransport(sources, transport);
  const endpoints =
    source === undefined ? [] : await source.fetchEndpoints(transportId);
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
    transport,
    // EVERY spelling the catalogues know, so a later transport switch is one
    // write instead of somebody looking the other ids up by hand.
    modelIds: entry.idsByTransport,
    dynamicProfile: deriveDynamicProfile(entry, input.now),
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
