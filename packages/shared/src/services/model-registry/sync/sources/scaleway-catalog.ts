import { z } from "zod";
import type {
  CatalogueCapabilities,
  CatalogueEntry,
  CatalogueSource,
} from "../../../../model-registry/catalogue";
import { normalizeProviderName } from "../../../../model-registry/provider-names";
import type { EndpointStat } from "../../../../model-registry/types";
import type { ScalewayModelSpec } from "./scaleway-model-specs";
import { fetchScalewayModelSpecs } from "./scaleway-model-specs";
import type { ScalewayProductFacts } from "./scaleway-product-catalog";
import { fetchScalewayProductFacts } from "./scaleway-product-catalog";
import { fetchJson } from "./wire";

/**
 * Scaleway Generative APIs as a catalogue source.
 *
 * Scaleway is a DIRECT provider, not an aggregator, and every difference from
 * the other two sources follows from that one fact:
 *
 * - **It serves each model itself, so a model has exactly one endpoint.** The
 *   others front a pool of competing hosts; here the pool is Scaleway. Nothing
 *   about that breaks the pool machinery — a pool of one routes fine — but it
 *   does mean a quarantine has no sibling to fall back to, so the verb for a
 *   failing Scaleway model is disabling the MODEL, not banning the host.
 * - **It publishes no percentiles.** No throughput, no latency, no uptime: the
 *   fields stay UNSET rather than zeroed, because a zero throughput would read
 *   as a measured standstill and sink the model in every speed-ranked picker.
 * - **It caps context below the model's own.** See `scaleway-model-specs.ts`.
 * - **Its data-retention stance is platform-wide**, not per route.
 *
 * It also takes three sources to describe one model, which is why this file is
 * a composition rather than a fetcher: `/v1/models` says what is actually
 * served, the product catalogue prices it and names its tasks, the published
 * specifications give it a context window. Only the first is authoritative
 * about EXISTENCE; the other two enrich and may come back empty.
 */

/**
 * `GET /{project}/v1/models`. The path is PROJECT-SCOPED — the bare
 * `api.scaleway.ai/v1/models` answers 403 with a valid key, which reads as a
 * permissions problem and is not one.
 */
const modelsUrl = (projectId: string) =>
  `https://api.scaleway.ai/${projectId}/v1/models`;

/**
 * Zero Data Retention, stated once for the whole platform: "By default we apply
 * a Zero Data Retention Policy" and "Your data is not used for training,
 * retraining, or improving the base models"
 * (`generative-apis/reference-content/data-privacy.mdx`, read 2026-08-30).
 *
 * A constant rather than a per-endpoint reading because there is nothing to
 * read per endpoint: one company serves every model here under one policy. This
 * is the property that makes the transport worth having — an EU-hosted route
 * with a retention stance that does not have to be probed model by model.
 */
const SCALEWAY_HAS_ZDR = true;

/** The `tasks` values that add an input modality. Text is always present. */
const MODALITY_BY_TASK: Readonly<Record<string, string>> = {
  vision: "image",
  audio_transcription: "audio",
};

/** A model answering on the chat route is a language model; embeddings are not. */
const CHAT_API = "/v1/chat/completions";

export const SCALEWAY_CATALOGUE_CAPABILITIES: CatalogueCapabilities = {
  // `supported_apis` separates chat from embeddings and transcription.
  identifiesModelType: true,
  // `tasks` names vision and audio transcription as data, not as a guess.
  publishesModalities: true,
  // `provider_name` — `Zai`, `Deepseek`, `BAAI` — rather than an id prefix.
  publishesOwner: true,
  // `/v1/models` carries a `created` stamp, but it dates the LISTING rather
  // than the model, and a listing date presented as a release date would sort
  // the whole fleet wrong.
  publishesReleaseDate: false,
  // Stated for the platform, not per model, so it is applied to the endpoint
  // rather than advertised here as a per-model hint.
  publishesZdrHint: false,
};

const listSchema = z.object({
  data: z
    .array(z.object({ id: z.string(), owned_by: z.string().nullish() }))
    .nullish(),
});

interface Snapshot {
  served: { id: string; ownedBy?: string }[];
  facts: Map<string, ScalewayProductFacts>;
  specs: Map<string, ScalewayModelSpec>;
}

/**
 * The models Scaleway will actually answer for.
 *
 * THROWS, for the same reason the aggregator catalogues do: a list that cannot
 * be read must not be mistaken for an empty one, or every Scaleway row would be
 * recorded as delisted in a single pass.
 *
 * Missing credentials are different from a failed call and return `[]` — a
 * shell with no Scaleway key serves no Scaleway models, which is true rather
 * than exceptional, and the sync's other transports carry on untouched.
 */
const fetchServed = async (): Promise<{ id: string; ownedBy?: string }[]> => {
  const token = Bun.env.SCW_SECRET_KEY;
  const projectId = Bun.env.SCW_PROJECT_ID;
  if (!token || !projectId) return [];
  const result = await fetchJson(modelsUrl(projectId), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!result.ok) {
    throw new Error(
      `scaleway models GET failed (${result.status.toString()}): ${result.detail}`,
    );
  }
  const parsed = listSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error("scaleway models response is not { data: [...] }");
  }
  return (parsed.data.data ?? []).map((entry) => ({
    id: entry.id,
    ownedBy: entry.owned_by ?? undefined,
  }));
};

const inputModalities = (tasks: readonly string[]): string[] => [
  "text",
  ...new Set(
    tasks.flatMap((task) => {
      const modality = MODALITY_BY_TASK[task];
      return modality === undefined ? [] : [modality];
    }),
  ),
];

/**
 * The parameters this model accepts, in the vocabulary the policy already
 * filters on — `tools` is the token `computeEligibleEndpoints` and the
 * published-model policy both look for.
 *
 * Absence is absence: a model whose specification could not be read advertises
 * nothing, and a tools-requiring role will pass it over rather than send tools
 * to a host that may drop them silently.
 */
const supportedParameters = (
  facts: ScalewayProductFacts | undefined,
  spec: ScalewayModelSpec | undefined,
): string[] => [
  ...(spec?.supportsTools === true ? ["tools"] : []),
  ...(spec?.supportsStructuredOutput === true ? ["structured_outputs"] : []),
  ...(facts?.reasoning === true ? ["reasoning"] : []),
];

const toEntry = (
  served: { id: string; ownedBy?: string },
  snapshot: Snapshot,
): CatalogueEntry => {
  const facts = snapshot.facts.get(served.id);
  const spec = snapshot.specs.get(served.id.toLowerCase());
  return {
    id: served.id,
    // No display name on any of the three sources. The id is the name Scaleway
    // itself shows, and inventing a prettier one would diverge from its console.
    name: served.id,
    description: "",
    owner: facts?.owner ?? served.ownedBy ?? "unknown",
    contextWindow: spec?.contextWindow,
    maxTokens: spec?.maxTokens,
    inputModalities: inputModalities(facts?.tasks ?? []),
    outputModalities: ["text"],
    supportedParameters: supportedParameters(facts, spec),
    pricing: facts?.pricing ?? {},
    ...(facts?.deprecated === true ? { deprecated: true } : {}),
    // `undefined` where the price list did not answer: unknown, not "not a
    // language model", so discovery must not read the absence as a rejection.
    isLanguageModel:
      facts === undefined ? undefined : facts.supportedApis.includes(CHAT_API),
  };
};

/**
 * Scaleway's single endpoint for one model, or `[]` when it cannot be described
 * completely.
 *
 * A stat needs both a context length and a price, and neither is inventable:
 * without the context we would size requests against a limit we do not know,
 * and without the price the pool median would be a guess. Returning nothing
 * leaves the model listed but unusable, which is the visible failure.
 */
const toEndpoint = (modelId: string, snapshot: Snapshot): EndpointStat[] => {
  const facts = snapshot.facts.get(modelId);
  const spec = snapshot.specs.get(modelId.toLowerCase());
  if (facts === undefined || spec?.contextWindow === undefined) return [];
  const inputPerMTok = facts.pricing.inputPerMTok;
  const outputPerMTok = facts.pricing.outputPerMTok;
  if (inputPerMTok === undefined || outputPerMTok === undefined) return [];
  return [
    {
      provider: normalizeProviderName("Scaleway"),
      displayName: "Scaleway",
      wireNames: { scaleway: "scaleway" },
      hasZdr: SCALEWAY_HAS_ZDR,
      contextLength: spec.contextWindow,
      maxCompletionTokens: spec.maxTokens,
      pricing: {
        inputPerMTok,
        outputPerMTok,
        ...(facts.pricing.cacheReadPerMTok === undefined
          ? {}
          : { cacheReadPerMTok: facts.pricing.cacheReadPerMTok }),
      },
      supportedParameters: supportedParameters(facts, spec),
      // Scaleway caches automatically and does not ask to be told where — its
      // documented hit ratio on recurring prefixes is 50–90%.
      supportsImplicitCaching: true,
    },
  ];
};

/**
 * The source, with its three fetches shared across the pass.
 *
 * The two enrichments are loaded ONCE per sync and held in the closure: the
 * product catalogue costs six paged calls and the specifications one, and
 * `fetchEndpoints` is called per model. Fetching them per model would turn
 * seven calls into seven hundred.
 */
export const createScalewaySource = (): CatalogueSource => {
  let snapshot: Promise<Snapshot> | undefined;
  const load = (): Promise<Snapshot> => {
    snapshot ??= (async () => {
      const [served, facts, specs] = await Promise.all([
        fetchServed(),
        fetchScalewayProductFacts(),
        fetchScalewayModelSpecs(),
      ]);
      return { served, facts, specs };
    })();
    return snapshot;
  };

  return {
    id: "scaleway",
    capabilities: SCALEWAY_CATALOGUE_CAPABILITIES,
    listModels: async () => {
      const loaded = await load();
      return loaded.served.map((served) => toEntry(served, loaded));
    },
    fetchEndpoints: async (modelId) => toEndpoint(modelId, await load()),
  };
};
