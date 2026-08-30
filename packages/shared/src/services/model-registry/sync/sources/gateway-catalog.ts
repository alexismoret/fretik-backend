import { z } from "zod";
import type {
  CatalogueCapabilities,
  CatalogueEntry,
} from "../../../../model-registry/catalogue";
import { fetchJson, perMTok, priceSchema } from "./wire";

/**
 * The Vercel AI Gateway catalogue — the sync's spine.
 *
 * `GET /v1/models`, PUBLIC: no key, no account. That matters, because the run
 * has to be able to tell "this model disappeared from the catalogue" from "our
 * credentials expired", and an unauthenticated endpoint cannot produce the
 * second failure. 360 entries on 2026-08-29, 239 of them `type: "language"`.
 *
 * Non-language entries (embedding, image, video, speech, transcription,
 * reranking, realtime) are RETURNED with their `type` — a caller that wants
 * them can have them — but only `language` is eligible for candidate discovery.
 * The rest have no endpoints route, no context window and in several cases no
 * per-token price at all.
 */

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

const entrySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  context_window: z.number().nullish(),
  max_tokens: z.number().nullish(),
  type: z.string(),
  owned_by: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  zdr: z.enum(["all", "some", "none"]).nullish(),
  released: z.number().nullish(),
  created: z.number().nullish(),
  pricing: z
    .object({
      input: priceSchema,
      output: priceSchema,
      input_cache_read: priceSchema,
      input_cache_write: priceSchema,
    })
    .nullish(),
});

const responseSchema = z.object({ data: z.array(z.unknown()) });

/**
 * What this catalogue can answer. It is the richer of the two on identity —
 * it classifies model types, names the author and dates every release — and
 * the poorer on modalities, which it only implies through tags.
 */
export const GATEWAY_CATALOGUE_CAPABILITIES: CatalogueCapabilities = {
  identifiesModelType: true,
  // `vision` and `file-input` are TAGS, so image and file are all this can ever
  // express; audio and video inputs are invisible to it. A source that reads
  // modalities from the response outranks this one on the merge.
  publishesModalities: false,
  publishesOwner: true,
  publishesReleaseDate: true,
  publishesZdrHint: true,
};

/**
 * Tags → modalities. The mapping is small because the vocabulary is: measured
 * across 239 language models on 2026-08-30, the only input-bearing tags are
 * `vision` (156), `file-input` (113) and `video-input` (11).
 */
const modalitiesFromTags = (tags: readonly string[]): string[] => {
  const modalities = ["text"];
  if (tags.includes("vision")) modalities.push("image");
  if (tags.includes("file-input")) modalities.push("file");
  if (tags.includes("video-input")) modalities.push("video");
  return modalities;
};

const toEntry = (raw: z.infer<typeof entrySchema>): CatalogueEntry => ({
  id: raw.id,
  name: raw.name ?? raw.id,
  description: raw.description ?? "",
  contextWindow: raw.context_window ?? undefined,
  maxTokens: raw.max_tokens ?? undefined,
  isLanguageModel: raw.type === "language",
  inputModalities: modalitiesFromTags(raw.tags ?? []),
  // No tag distinguishes an image or audio GENERATOR here, and a language
  // model's output is text. A source that publishes the real list wins on merge.
  outputModalities: ["text"],
  supportedParameters: raw.supported_parameters ?? [],
  pricing: {
    inputPerMTok: perMTok(raw.pricing?.input),
    outputPerMTok: perMTok(raw.pricing?.output),
    cacheReadPerMTok: perMTok(raw.pricing?.input_cache_read),
    cacheWritePerMTok: perMTok(raw.pricing?.input_cache_write),
  },
  zdr: raw.zdr ?? undefined,
  owner: raw.owned_by ?? raw.id.split("/")[0] ?? "unknown",
  // Unix SECONDS. Zero is the epoch, which no model was released on, so it
  // reads as unset rather than as 1970.
  releasedAt:
    raw.released !== null && raw.released !== undefined && raw.released > 0
      ? new Date(raw.released * 1000)
      : undefined,
});

/**
 * The whole catalogue. Throws on an unreachable or unreadable catalogue: the
 * run treats that as fatal and leaves every existing row untouched, because a
 * blind sync would read as "every model vanished".
 *
 * One malformed ENTRY is skipped rather than fatal — but a body whose entries
 * ALL fail to parse is a shape change, and that is fatal for the same reason.
 */
export const fetchGatewayCatalog = async (): Promise<CatalogueEntry[]> => {
  const result = await fetchJson(CATALOG_URL);
  if (!result.ok) {
    throw new Error(
      `gateway catalogue GET failed (${result.status.toString()}): ${result.detail}`,
    );
  }
  const parsed = responseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error("gateway catalogue response is not { data: [...] }");
  }
  const entries: CatalogueEntry[] = [];
  for (const raw of parsed.data.data) {
    const entry = entrySchema.safeParse(raw);
    if (entry.success) entries.push(toEntry(entry.data));
  }
  if (entries.length === 0 && parsed.data.data.length > 0) {
    throw new Error(
      `gateway catalogue returned ${parsed.data.data.length.toString()} entries, none of which parsed — the response shape changed`,
    );
  }
  return entries;
};
