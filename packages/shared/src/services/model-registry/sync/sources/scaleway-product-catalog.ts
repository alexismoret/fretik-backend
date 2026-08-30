import { z } from "zod";
import type { CataloguePricing } from "../../../../model-registry/catalogue";
import { fetchJson } from "./wire";

/**
 * Scaleway's public product catalogue — the price list, and rather more.
 *
 * `GET /product-catalog/v2alpha1/public-catalog/products`, authenticated with
 * the account token. Scaleway's OpenAI-compatible `/v1/models` publishes only
 * `{id, object, created, owned_by}`, so on its own a Scaleway model arrives with
 * no price, no modalities and no owner. This catalogue supplies all three, and
 * it is the ONLY machine-readable source that does: the aggregators price hosts
 * we would not be routing through, and Managed Inference describes a different
 * product (deployments we host, which we do not do).
 *
 * Each model contributes several SKUs — one per token type, doubled by
 * consumption mode — and every one of them carries a
 * `properties.generative_apis` block:
 *
 * | field                      | what it settles                              |
 * |----------------------------|----------------------------------------------|
 * | `token_type`               | `input_token`, `output_token`, `input_cached_token`, `input_duration` |
 * | `consumption_mode`         | `realtime` against the half-price `batch` list |
 * | `tasks`                    | `chat`, `code`, `vision`, `audio_transcription`, `embeddings` |
 * | `supported_apis`           | `/v1/chat/completions` against `/v1/embeddings` |
 * | `provider_name`            | the upstream author (`Zai`, `Deepseek`, `Qwen`) |
 * | `reasoning`                | plus `supported_reasoning_values`, the real per-model scale |
 *
 * Two properties of the response shape are load-bearing:
 *
 * 1. **`product` IS the model id**, character for character — verified against
 *    all 15 models `/v1/models` served on 2026-08-30. So entries are keyed on
 *    that field rather than on the SKU path, which additionally encodes the
 *    token type and the region and would have to be unparsed.
 * 2. **The endpoint ignores unknown query parameters.** `product_category=…`,
 *    `service_category=…` and `product_categories=…` were each probed and each
 *    returned the unfiltered 5,456 rows, so the whole catalogue is paged and
 *    filtered here. `page_size=1000` is accepted, which makes that six calls.
 */

/** Only these SKUs are ours; the other 5,300 describe unrelated products. */
const GENERATIVE_APIS_CATEGORY = "Generative APIs";

/**
 * The list quotes the discounted batch rate under the same `product`. Reading
 * it as the price would understate every model by half.
 */
const REALTIME = "realtime";

const CATALOG_URL =
  "https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products";

const PAGE_SIZE = 1000;

/** 5,456 rows over 1,000 per page. The stop exists so a paging bug cannot spin. */
const MAX_PAGES = 20;

/**
 * EUR → USD, so a Scaleway price can be compared with a `PricingSnapshot`.
 *
 * Every other source on the wire quotes USD, and `PricingSnapshot` is USD per
 * million tokens throughout — including `PROMOTION_PRICE_CAPS`, which decides
 * whether a promoted model arrives enabled. Scaleway quotes EUR, so the two
 * meet here or they meet nowhere.
 *
 * The rate is a CONSTANT reviewed in review, not a live lookup: a budget gate
 * that moves with the currency market would flip a model's `enabled` overnight
 * for a reason nobody changed, and a new network dependency on the sync's
 * critical path buys nothing at this precision.
 *
 * It is deliberately set ABOVE the market — the ECB reference rate was 1.1643
 * on 2026-08-28 — so drift can only ever make us stricter. Overstating a cost
 * withholds `enabled` from a model that would have fit, which an operator sees
 * and can flip by hand; understating it spends money nobody approved, which
 * nothing surfaces.
 */
const EUR_TO_USD = 1.2;

/**
 * `status` values that mean "still shipping". Anything else — `end_of_new_features`
 * is the live example, carried today by `pixtral-12b-2409` and
 * `qwen3-coder-30b-a3b-instruct` — marks a model that is still SERVED and must
 * keep working, but must not be discovered as a new candidate: Scaleway's own
 * table gives both an end-of-life date within months.
 */
const SHIPPING_STATUSES: readonly string[] = [
  "general_availability",
  "preview",
];

const retailPriceSchema = z
  .object({
    retail_price: z
      .object({
        currency_code: z.string().nullish(),
        units: z.number().nullish(),
        nanos: z.number().nullish(),
      })
      .nullish(),
  })
  .nullish();

const productSchema = z.object({
  product: z.string(),
  product_category: z.string().nullish(),
  status: z.string().nullish(),
  /** `{unit: "token", size: 1000}`, or `{unit: "second", size: 60}` for audio. */
  unit_of_measure: z
    .object({ unit: z.string().nullish(), size: z.number().nullish() })
    .nullish(),
  price: retailPriceSchema,
  properties: z
    .object({
      generative_apis: z
        .object({
          provider_name: z.string().nullish(),
          tasks: z.array(z.string()).nullish(),
          supported_apis: z.array(z.string()).nullish(),
          reasoning: z.boolean().nullish(),
          token_type: z.string().nullish(),
          consumption_mode: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const responseSchema = z.object({
  products: z.array(z.unknown()).nullish(),
  total_count: z.number().nullish(),
});

/** What the catalogue knows about one model, folded across its SKUs. */
export interface ScalewayProductFacts {
  /** `provider_name`, e.g. `Zai` — normalised into a family by the caller. */
  owner?: string;
  /** `chat`, `code`, `vision`, `audio_transcription`, `embeddings`. */
  tasks: string[];
  /** `/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/transcriptions`. */
  supportedApis: string[];
  /** Whether the model accepts a reasoning effort at all. */
  reasoning: boolean;
  /** Served, but past its feature life: never a new candidate. */
  deprecated: boolean;
  pricing: CataloguePricing;
}

/**
 * EUR per `size` units → USD per 1,000,000 tokens.
 *
 * Returns `undefined` for anything not billed per token: `whisper-large-v3` is
 * priced per 60 SECONDS of audio, and converting that as if it were tokens
 * would invent a rate three orders of magnitude off.
 */
const usdPerMTok = (
  raw: z.infer<typeof retailPriceSchema>,
  unit: { unit?: string | null; size?: number | null } | null | undefined,
): number | undefined => {
  const price = raw?.retail_price;
  if (price === null || price === undefined) return undefined;
  if (unit?.unit !== "token") return undefined;
  const size = unit.size;
  if (size === null || size === undefined || size <= 0) return undefined;
  const eur = (price.units ?? 0) + (price.nanos ?? 0) / 1e9;
  if (!Number.isFinite(eur)) return undefined;
  return Math.round((eur / size) * 1e6 * EUR_TO_USD * 1e6) / 1e6;
};

/**
 * The higher of two rates for the same token type.
 *
 * Only reachable if Scaleway ever prices one model differently per region — it
 * publishes `fr-par` alone today. Taking the higher keeps the budget gate on
 * the safe side of a split it cannot otherwise resolve.
 */
const dearer = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

const fold = (
  facts: ScalewayProductFacts,
  raw: z.infer<typeof productSchema>,
  props: NonNullable<
    NonNullable<z.infer<typeof productSchema>["properties"]>["generative_apis"]
  >,
): ScalewayProductFacts => {
  const rate = usdPerMTok(raw.price, raw.unit_of_measure);
  const pricing = { ...facts.pricing };
  if (props.token_type === "input_token")
    pricing.inputPerMTok = dearer(pricing.inputPerMTok, rate);
  if (props.token_type === "output_token")
    pricing.outputPerMTok = dearer(pricing.outputPerMTok, rate);
  if (props.token_type === "input_cached_token")
    pricing.cacheReadPerMTok = dearer(pricing.cacheReadPerMTok, rate);
  return {
    owner: facts.owner ?? props.provider_name ?? undefined,
    // A union across SKUs: every SKU of a model repeats them, and a union
    // cannot lose a task that only one row happened to list.
    tasks: [...new Set([...facts.tasks, ...(props.tasks ?? [])])],
    supportedApis: [
      ...new Set([...facts.supportedApis, ...(props.supported_apis ?? [])]),
    ],
    reasoning: facts.reasoning || (props.reasoning ?? false),
    // One row past its feature life condemns the model: the status is a
    // property of the model, and the SKUs only ever disagree by being stale.
    deprecated:
      facts.deprecated ||
      (raw.status != null && !SHIPPING_STATUSES.includes(raw.status)),
    pricing,
  };
};

const EMPTY: ScalewayProductFacts = {
  tasks: [],
  supportedApis: [],
  reasoning: false,
  deprecated: false,
  pricing: {},
};

/**
 * Every Generative APIs model the price list knows, keyed by model id.
 *
 * ENRICHMENT, so it never throws: an empty map leaves Scaleway models without a
 * price, which makes them unpromotable and leaves published rows on the prices
 * they already had. That is the failure we want. The alternative — treating an
 * unreadable price list as fatal — would take down a sync that has nothing to
 * do with Scaleway.
 *
 * No token, no call: the sync runs in shells that carry no Scaleway credentials
 * at all, and an empty map is the honest answer there.
 */
export const fetchScalewayProductFacts = async (): Promise<
  Map<string, ScalewayProductFacts>
> => {
  const token = Bun.env.SCW_SECRET_KEY;
  const facts = new Map<string, ScalewayProductFacts>();
  if (token === undefined || token === "") return facts;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchJson(
      `${CATALOG_URL}?page_size=${PAGE_SIZE.toString()}&page=${page.toString()}`,
      { headers: { "x-auth-token": token } },
    );
    if (!result.ok) return facts;
    const parsed = responseSchema.safeParse(result.body);
    if (!parsed.success) return facts;
    const products = parsed.data.products ?? [];
    for (const raw of products) {
      const product = productSchema.safeParse(raw);
      if (!product.success) continue;
      if (product.data.product_category !== GENERATIVE_APIS_CATEGORY) continue;
      const props = product.data.properties?.generative_apis;
      if (props == null || props.consumption_mode !== REALTIME) continue;
      facts.set(
        product.data.product,
        fold(facts.get(product.data.product) ?? EMPTY, product.data, props),
      );
    }
    if (products.length < PAGE_SIZE) break;
  }
  return facts;
};
