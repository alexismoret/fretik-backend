import { z } from "zod";
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

/** Catalogue prices, converted. Every field is optional: a video model has none. */
export interface CatalogPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface GatewayCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Absent outside `language` — a speech model has no context window. */
  contextWindow?: number;
  maxTokens?: number;
  /** `language`, `embedding`, `image`, … Only `language` can be a candidate. */
  type: string;
  tags: string[];
  supportedParameters: string[];
  pricing: CatalogPricing;
  /**
   * The catalogue's own zero-retention claim: `all` (every endpoint), `some`
   * (at least one), `none`. It is a useful PRE-FILTER — discovery does not
   * spend an endpoint fetch on a `none` — but it is not a verdict: `some` says
   * nothing about the endpoints our pool actually routes to, which is why the
   * live probe in `zdr-probe.ts` remains the authority.
   */
  zdr?: "all" | "some" | "none";
  /** Upstream author (`anthropic`, `google`), the `family` a profile carries. */
  owner: string;
  /** Unix seconds, as the catalogue reports them. */
  released?: number;
  created?: number;
}

const toEntry = (raw: z.infer<typeof entrySchema>): GatewayCatalogEntry => ({
  id: raw.id,
  name: raw.name ?? raw.id,
  description: raw.description ?? "",
  contextWindow: raw.context_window ?? undefined,
  maxTokens: raw.max_tokens ?? undefined,
  type: raw.type,
  tags: raw.tags ?? [],
  supportedParameters: raw.supported_parameters ?? [],
  pricing: {
    inputPerMTok: perMTok(raw.pricing?.input),
    outputPerMTok: perMTok(raw.pricing?.output),
    cacheReadPerMTok: perMTok(raw.pricing?.input_cache_read),
    cacheWritePerMTok: perMTok(raw.pricing?.input_cache_write),
  },
  zdr: raw.zdr ?? undefined,
  owner: raw.owned_by ?? raw.id.split("/")[0] ?? "unknown",
  released: raw.released ?? undefined,
  created: raw.created ?? undefined,
});

/**
 * The whole catalogue. Throws on an unreachable or unreadable catalogue: the
 * run treats that as fatal and leaves every existing row untouched, because a
 * blind sync would read as "every model vanished".
 *
 * One malformed ENTRY is skipped rather than fatal — but a body whose entries
 * ALL fail to parse is a shape change, and that is fatal for the same reason.
 */
export const fetchGatewayCatalog = async (): Promise<GatewayCatalogEntry[]> => {
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
  const entries: GatewayCatalogEntry[] = [];
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
