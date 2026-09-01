import { z } from "zod";
import type {
  CatalogueCapabilities,
  CatalogueEntry,
} from "../../../../model-registry/catalogue";
import { fetchJson, perMTok, priceSchema } from "./wire";

/**
 * The OpenRouter model catalogue.
 *
 * `GET /api/v1/models`, PUBLIC: no key, no account — the same property that
 * makes the gateway catalogue usable for delisting detection. 396 entries on
 * 2026-08-30.
 *
 * It exists for two reasons, and the first is not "redundancy":
 *
 * 1. **Identity on the transport the fleet actually runs on.** Discovery used
 *    to read the gateway catalogue alone, so every candidate arrived with a
 *    gateway id and nothing else — 110 of them on 2026-08-30, against 22
 *    published models all routing through OpenRouter. Promoting one moved a
 *    model onto a transport the fleet does not use. Reading both catalogues
 *    gives a model its id on each transport that serves it, and the seed's own
 *    rule (`startingTransport`) then puts it where the rest of the fleet is.
 * 2. **Modalities as FACTS.** This catalogue publishes
 *    `architecture.input_modalities` verbatim — all five values — where the
 *    gateway leaves them to be inferred from two tags. That inference cannot
 *    express audio or video input at all, so a model that accepts either was
 *    silently recorded as text-only.
 *
 * What it cannot answer, and why the gateway catalogue stays: it publishes no
 * model TYPE (an embedding model is indistinguishable from a chat model here),
 * no author field (only the id prefix, which says `qwen` where the gateway says
 * `alibaba`), and no zero-retention hint (that lives in a separate per-route
 * list). `capabilities` below states exactly that, and the merge reads it.
 */

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

const entrySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  context_length: z.number().nullish(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  top_provider: z
    .object({ max_completion_tokens: z.number().nullish() })
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  // The reasoning contract, published per model since 2026 and read by nothing
  // until 2026-08-30 — 271 of 396 entries carry one, 130 with the exact ladder.
  reasoning: z
    .object({
      mandatory: z.boolean().nullish(),
      supported_efforts: z.array(z.string()).nullish(),
      default_effort: z.string().nullish(),
      supports_max_tokens: z.boolean().nullish(),
    })
    .nullish(),
  pricing: z
    .object({
      prompt: priceSchema,
      completion: priceSchema,
      input_cache_read: priceSchema,
      input_cache_write: priceSchema,
    })
    .nullish(),
});

const responseSchema = z.object({ data: z.array(z.unknown()) });

export const OPENROUTER_CATALOGUE_CAPABILITIES: CatalogueCapabilities = {
  // No `type` field: an embedding model looks like a chat model from here.
  identifiesModelType: false,
  publishesModalities: true,
  // Only the id prefix, which names the model LINE rather than the company.
  publishesOwner: false,
  publishesReleaseDate: true,
  // Zero retention is per ROUTE here, fetched separately by `openrouter-zdr`.
  publishesZdrHint: false,
  // The only source that does. It is why a promoted model can offer a depth
  // menu at all.
  publishesReasoningContract: true,
  // `throughput_last_30m` / `latency_last_30m` — but AUTH-GATED: without
  // `OPENROUTER_API_KEY` they come back null on a 200 for every endpoint,
  // which is why a missing key must degrade the run rather than pass silently.
  publishesPercentiles: true,
  publishesToolChoice: true,
  publishesUptime: true,
};

const toEntry = (raw: z.infer<typeof entrySchema>): CatalogueEntry => ({
  id: raw.id,
  name: raw.name ?? raw.id,
  description: raw.description ?? "",
  contextWindow: raw.context_length ?? undefined,
  maxTokens: raw.top_provider?.max_completion_tokens ?? undefined,
  // `text` is guaranteed rather than assumed: an entry that listed none would
  // otherwise describe a model accepting no input at all.
  inputModalities: raw.architecture?.input_modalities ?? ["text"],
  outputModalities: raw.architecture?.output_modalities ?? ["text"],
  supportedParameters: raw.supported_parameters ?? [],
  // `mandatory` is the one field every contract carries, so its absence marks
  // the whole block as absent rather than defaulting to `false` — "the
  // catalogue did not say" and "reasoning can be turned off" are different
  // facts, and only the second may reach the depth menu.
  ...(raw.reasoning?.mandatory === null ||
  raw.reasoning?.mandatory === undefined
    ? {}
    : {
        reasoning: {
          mandatory: raw.reasoning.mandatory,
          ...(raw.reasoning.supported_efforts
            ? { supportedEfforts: raw.reasoning.supported_efforts }
            : {}),
          ...(raw.reasoning.default_effort
            ? { defaultEffort: raw.reasoning.default_effort }
            : {}),
          ...(raw.reasoning.supports_max_tokens === null ||
          raw.reasoning.supports_max_tokens === undefined
            ? {}
            : { supportsMaxTokens: raw.reasoning.supports_max_tokens }),
        },
      }),
  pricing: {
    inputPerMTok: perMTok(raw.pricing?.prompt),
    outputPerMTok: perMTok(raw.pricing?.completion),
    cacheReadPerMTok: perMTok(raw.pricing?.input_cache_read),
    cacheWritePerMTok: perMTok(raw.pricing?.input_cache_write),
  },
  owner: raw.id.split("/")[0] ?? "unknown",
  releasedAt:
    raw.created !== null && raw.created !== undefined && raw.created > 0
      ? new Date(raw.created * 1000)
      : undefined,
});

/**
 * The whole catalogue. Throws for the same reason its gateway twin does: a
 * catalogue that cannot be read must not be mistaken for a catalogue that came
 * back empty, or a sync would record every model as delisted.
 */
export const fetchOpenRouterCatalog = async (): Promise<CatalogueEntry[]> => {
  const result = await fetchJson(CATALOG_URL);
  if (!result.ok) {
    throw new Error(
      `OpenRouter catalogue GET failed (${result.status.toString()}): ${result.detail}`,
    );
  }
  const parsed = responseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error("OpenRouter catalogue response is not { data: [...] }");
  }
  const entries: CatalogueEntry[] = [];
  for (const raw of parsed.data.data) {
    const entry = entrySchema.safeParse(raw);
    if (entry.success) entries.push(toEntry(entry.data));
  }
  if (entries.length === 0 && parsed.data.data.length > 0) {
    throw new Error(
      `OpenRouter catalogue returned ${parsed.data.data.length.toString()} entries, none of which parsed — the response shape changed`,
    );
  }
  return entries;
};
