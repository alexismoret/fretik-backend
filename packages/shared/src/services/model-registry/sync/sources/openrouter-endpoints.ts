import { z } from "zod";
import { normalizeProviderName } from "../../../../model-registry/provider-names";
import type { EndpointStat } from "../../../../model-registry/types";
import { zdrRouteKey } from "./openrouter-zdr";
import {
  encodeModelPath,
  endpointPricingSchema,
  fetchJson,
  toPricingSnapshot,
} from "./wire";

/**
 * Per-provider figures for one model on OpenRouter.
 *
 * `GET /api/v1/models/{author}/{slug}/endpoints`. The route is public, but the
 * PERCENTILES ARE NOT: unauthenticated, `latency_last_30m` and
 * `throughput_last_30m` come back `null` for every endpoint; with a Bearer key
 * they are objects. Verified 2026-08-29 on `deepseek/deepseek-chat-v3.1` — 8
 * endpoints, null percentiles anonymous, `{p50,p75,p90,p99}` authenticated. So
 * the key is optional and is sent when present.
 *
 * OpenRouter is normally the ENRICHMENT source, and its one irreplaceable
 * column is `quantization`: it is the only API that reports serving precision,
 * and `fp4` versus `bf16` is a quality difference no other field exposes.
 *
 * Two of its columns deliberately go nowhere:
 *
 * - `uptime_last_30m` / `uptime_last_5m` — there is no 1 h or 15 m figure to map
 *   them onto, and writing a 30-minute number into `uptime1h` would make a
 *   fabricated value indistinguishable from a measured one after the merge.
 *   `uptime_last_1d`, which the policy's floor actually reads, maps directly.
 * - `p90` / `p99` — the percentile objects carry no p95, and the nearest
 *   neighbour is not the value the field promises.
 */

const percentileSchema = z
  .object({
    p50: z.number().nullish(),
    p75: z.number().nullish(),
    p90: z.number().nullish(),
    p99: z.number().nullish(),
  })
  .nullish();

const endpointSchema = z.object({
  provider_name: z.string(),
  /**
   * The route, e.g. `deepinfra/fp4`, `mistral/zdr`, `google-ai-studio`. It is
   * how a row is matched against the zero-retention list, and its head is the
   * provider SLUG the routing preferences expect — which `provider_name` is
   * not (`Amazon Bedrock` against `amazon-bedrock`).
   */
  tag: z.string().nullish(),
  context_length: z.number().nullish(),
  max_completion_tokens: z.number().nullish(),
  pricing: endpointPricingSchema,
  supported_parameters: z.array(z.string()).nullish(),
  supports_implicit_caching: z.boolean().nullish(),
  quantization: z.string().nullish(),
  status: z.number().nullish(),
  uptime_last_1d: z.number().nullish(),
  latency_last_30m: percentileSchema,
  throughput_last_30m: percentileSchema,
});

const responseSchema = z.object({
  data: z.object({ endpoints: z.array(z.unknown()).nullish() }),
});

const toStat = (
  raw: z.infer<typeof endpointSchema>,
  modelId: string,
  zdrRoutes: Set<string> | undefined,
): EndpointStat | undefined => {
  const pricing = toPricingSnapshot(raw.pricing);
  if (pricing === undefined || raw.context_length == null) return undefined;
  // Absent list or absent tag both leave the stance UNSET rather than false:
  // "we could not check" and "checked, not zero-retention" are different
  // claims, and only the second one may shrink a pool.
  const hasZdr =
    zdrRoutes === undefined || raw.tag == null
      ? undefined
      : zdrRoutes.has(zdrRouteKey(modelId, raw.tag));
  // The tag's head is the provider SLUG the routing preferences expect, and
  // `provider_name` is a display string that often is not (`Amazon Bedrock`
  // against `amazon-bedrock`, `Claude Platform on AWS` against
  // `claude-on-aws`). Verified against `GET /api/v1/providers` over four
  // models on 2026-08-29: 45 of 46 heads were listed slugs, the exception
  // being a route variant (`sambanova-turbo`) that is itself a valid filter
  // token. Falling back to the display name only when there is no tag keeps a
  // row usable rather than dropping it.
  const wireName = raw.tag?.split("/")[0] ?? raw.provider_name;
  return {
    // The IDENTITY comes from the slug too, not from the display name, because
    // the display name is ambiguous where it matters most: OpenRouter labels
    // its Vertex route plainly `Google`, which folds to the same `google` as
    // `Google AI Studio` — two different routes, with different retention and
    // different prices, collapsing into one host that a quarantine would then
    // hit both halves of. The slug separates them (`google-vertex` against
    // `google-ai-studio`), and it is what the platform itself keys on.
    // Compared across 49 hosts on 2026-08-29: the two agree on 46, and on the
    // three that differ — this one, `Mancer 2`/`mancer`, `Claude Platform on
    // AWS`/`claude-on-aws` — the slug is the better name every time.
    provider: normalizeProviderName(wireName),
    displayName: raw.provider_name,
    wireNames: { openrouter: wireName },
    ...(hasZdr === undefined ? {} : { hasZdr }),
    contextLength: raw.context_length,
    maxCompletionTokens: raw.max_completion_tokens ?? undefined,
    pricing,
    supportedParameters: raw.supported_parameters ?? [],
    supportsImplicitCaching: raw.supports_implicit_caching ?? undefined,
    quantization: raw.quantization ?? undefined,
    uptime1d: raw.uptime_last_1d ?? undefined,
    throughputP50: raw.throughput_last_30m?.p50 ?? undefined,
    latencyP50Ms: raw.latency_last_30m?.p50 ?? undefined,
    status: raw.status ?? undefined,
  };
};

/**
 * Endpoints for one OpenRouter model id, or `[]` on 404 — a model that does not
 * exist there is NORMAL, not an error: the two catalogues do not overlap and
 * nothing derives one id from the other (`zai/glm-5.2` has no OpenRouter twin,
 * verified 2026-08-29). Any other non-2xx throws.
 */
export const fetchOpenRouterEndpoints = async (
  modelId: string,
  zdrRoutes?: Set<string>,
): Promise<EndpointStat[]> => {
  const apiKey = Bun.env.OPENROUTER_API_KEY;
  const result = await fetchJson(
    `https://openrouter.ai/api/v1/models/${encodeModelPath(modelId)}/endpoints`,
    apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : undefined,
  );
  if (!result.ok) {
    if (result.status === 404) return [];
    throw new Error(
      `openrouter endpoints GET ${modelId} failed (${result.status.toString()}): ${result.detail}`,
    );
  }
  const parsed = responseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error(
      `openrouter endpoints ${modelId}: unexpected response shape`,
    );
  }
  const stats: EndpointStat[] = [];
  for (const raw of parsed.data.data.endpoints ?? []) {
    const endpoint = endpointSchema.safeParse(raw);
    if (!endpoint.success) continue;
    const stat = toStat(endpoint.data, modelId, zdrRoutes);
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
};
