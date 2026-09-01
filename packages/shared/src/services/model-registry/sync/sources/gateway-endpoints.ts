import { z } from "zod";
import { normalizeProviderName } from "../../../../model-registry/provider-names";
import type { EndpointStat } from "../../../../model-registry/types";
import {
  encodeModelPath,
  endpointPricingSchema,
  fetchJson,
  toPricingSnapshot,
} from "./wire";

/**
 * Per-provider figures for one model on the Vercel AI Gateway.
 *
 * `GET /v1/models/{id}/endpoints`, public like the catalogue. This is the
 * PRIMARY source for a model served on the gateway: it is the only one that
 * describes the endpoints a call can actually land on, and `contextLength`
 * varies wildly between them — 40 960 / 131 072 / 262 144 for the three hosts of
 * one Qwen model, measured 2026-08-29. Budgeting against the catalogue headline
 * instead of the pool minimum silently overflows on the smallest.
 *
 * Everything past the provider name is optional on purpose: a host with no
 * recent traffic reports `latency_last_1h: null` and `throughput_last_1h: null`,
 * and `uptime_last_1h` is null far more often than it is set. `quantization` is
 * present in the payload but has been null on every gateway endpoint we have
 * looked at — OpenRouter is the only source that fills it.
 */

const percentileSchema = z
  .object({ p50: z.number().nullish(), p95: z.number().nullish() })
  .nullish();

const endpointSchema = z.object({
  provider_name: z.string(),
  context_length: z.number().nullish(),
  max_completion_tokens: z.number().nullish(),
  pricing: endpointPricingSchema,
  supported_parameters: z.array(z.string()).nullish(),
  supports_implicit_caching: z.boolean().nullish(),
  // Per-endpoint zero-retention status, and the field that retires an entire
  // subsystem: the previous transport exposed nothing of the kind, so
  // eligibility had to be discovered by issuing a request and reading back
  // which host answered. Three-valued in practice — `true`, `false`, and
  // `null` for hosts whose stance the gateway has not established (measured
  // across 17 endpoints, 2026-08-29).
  has_zdr: z.boolean().nullish(),
  quantization: z.string().nullish(),
  status: z.number().nullish(),
  uptime_last_15m: z.number().nullish(),
  uptime_last_1h: z.number().nullish(),
  uptime_last_1d: z.number().nullish(),
  latency_last_1h: percentileSchema,
  throughput_last_1h: percentileSchema,
});

const responseSchema = z.object({
  data: z.object({ endpoints: z.array(z.unknown()).nullish() }),
});

const toStat = (
  raw: z.infer<typeof endpointSchema>,
): EndpointStat | undefined => {
  const pricing = toPricingSnapshot(raw.pricing);
  // An endpoint the source neither sizes nor prices cannot be budgeted against
  // nor compared, and inventing a zero for either would corrupt the pool
  // minimum and the pool median. Never observed on this API; dropped if it ever
  // happens rather than silently absorbed.
  if (pricing === undefined || raw.context_length == null) return undefined;
  return {
    provider: normalizeProviderName(raw.provider_name),
    displayName: raw.provider_name,
    // Here the reported name IS the filter token — proven by the gateway's own
    // refusal, which enumerates them: "No available providers match the 'only'
    // filter: … Available providers are: baseten, bedrock, cerebras,
    // fireworks, groq, nebius, parasail, togetherai" (2026-08-29). Note
    // `togetherai`, which our identity folds to `together`: sending the
    // identity here is the request that error came from.
    wireNames: { gateway: raw.provider_name },
    contextLength: raw.context_length,
    maxCompletionTokens: raw.max_completion_tokens ?? undefined,
    pricing,
    supportedParameters: raw.supported_parameters ?? [],
    supportsImplicitCaching: raw.supports_implicit_caching ?? undefined,
    hasZdr: raw.has_zdr ?? undefined,
    quantization: raw.quantization ?? undefined,
    uptime15m: raw.uptime_last_15m ?? undefined,
    uptime1h: raw.uptime_last_1h ?? undefined,
    uptime1d: raw.uptime_last_1d ?? undefined,
    throughputP50: raw.throughput_last_1h?.p50 ?? undefined,
    throughputP95: raw.throughput_last_1h?.p95 ?? undefined,
    latencyP50Ms: raw.latency_last_1h?.p50 ?? undefined,
    latencyP95Ms: raw.latency_last_1h?.p95 ?? undefined,
    status: raw.status ?? undefined,
  };
};

/**
 * Endpoints for one gateway model id. Throws on any non-2xx, INCLUDING 404: a
 * row that names a gateway id the gateway no longer serves is a fact the run
 * has to surface, not absorb.
 *
 * `timeoutMs` exists for callers who are somebody's open request rather than a
 * nightly job: the default 20 s is right for a sync that would rather wait than
 * lose a model, and far too long for a page waiting on a scorecard.
 */
export const fetchGatewayEndpoints = async (
  modelId: string,
  options?: { timeoutMs?: number },
): Promise<EndpointStat[]> => {
  const result = await fetchJson(
    `https://ai-gateway.vercel.sh/v1/models/${encodeModelPath(modelId)}/endpoints`,
    options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  if (!result.ok) {
    throw new Error(
      `gateway endpoints GET ${modelId} failed (${result.status.toString()}): ${result.detail}`,
    );
  }
  const parsed = responseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error(`gateway endpoints ${modelId}: unexpected response shape`);
  }
  const stats: EndpointStat[] = [];
  for (const raw of parsed.data.data.endpoints ?? []) {
    const endpoint = endpointSchema.safeParse(raw);
    if (!endpoint.success) continue;
    const stat = toStat(endpoint.data);
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
};
