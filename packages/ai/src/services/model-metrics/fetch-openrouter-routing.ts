import { OPENROUTER_API_BASE_URL } from "@fretik/shared/lib/openrouter";
import { z } from "zod";
import { MODEL_PROFILES } from "../../lib/model-registry/profiles";
import type { ModelProfile } from "../../lib/model-registry/types";

/**
 * Resolve, per profile, the OpenRouter endpoint our traffic ACTUALLY reaches,
 * and read that endpoint's price and measured throughput.
 *
 * # Why this exists (2026-08-03)
 *
 * `assessment.pricing` was hand-curated with no drift check — `models:check`
 * validates only the `catalog` block. An audit of all 22 profiles against the
 * live API found three wrong, one badly:
 *
 * - **`deepseek-v4-pro` was priced at an endpoint we cannot reach.** The
 *   recorded $0.435/$0.87/$0.0036 is DeepSeek's first-party endpoint, which is
 *   NOT in the ZDR pool. Reachable routes bill ~$1.3/$2.6/$0.10 — 3× the input
 *   and 28× the cached-input rate. Since a Fretik turn is cache-read dominated,
 *   that one field made the model look CHEAPER than MiniMax M3 when it is ~3×
 *   dearer: 4 rank positions and a full badge step.
 * - `deepseek-v4-flash` was priced at list ($0.14) while pinned to DeepInfra
 *   ($0.09) — penalising the default flagship by 1.56×.
 * - `glm-5.2` matched no live endpoint at all.
 *
 * # Why a live PROBE and not a catalog read
 *
 * ZDR eligibility is exposed NOWHERE in the public API — not on
 * `/models/{id}/endpoints` (which does carry per-endpoint pricing,
 * `supported_parameters` and quantization) and not on `/providers` (policy URLs
 * only). The reachable pool therefore cannot be derived offline, and any
 * "cheapest endpoint" heuristic reproduces the exact bug above: for
 * `deepseek-v4-pro` the cheapest endpoint IS the unreachable one. The only
 * reliable signal is to ask for a completion with the real provider block and
 * read back which upstream served it.
 *
 * # Throughput and latency ride along free
 *
 * `/models/{id}/endpoints` returns `latency_last_30m` and
 * `throughput_last_30m` as p50/p75/p90/p99 distributions — but ONLY when the
 * request is AUTHENTICATED (both are null otherwise, which is why they looked
 * unavailable at first). They are real aggregates over 30 minutes of live
 * traffic on that specific upstream, which is strictly better than timing our
 * own probe: throughput rises with output length, so a `max_tokens: 1` call
 * measures ~1 tok/s and tells you nothing. We read p50 of the endpoint we
 * actually route to.
 *
 * # Why the POOL and not a single probe
 *
 * A single probe is a SAMPLE, not the expected value. Three consecutive probes
 * of `deepseek-v4-pro` returned DeepInfra (cache $0.10), then DigitalOcean
 * ($0.348), then CoreWeave ($0.14) — OpenRouter load-balances across the pool,
 * and for that model the reachable endpoints span $1.13-1.74 input and
 * $0.094-0.348 cached, a 3.7× spread on the field that dominates our cost. So
 * we enumerate the reachable pool by successive `ignore` and take the MEDIAN
 * per field, which is stable across refreshes and reflects what we pay on
 * average.
 *
 * EXCEPT when the profile pins `provider.order`: a pin is honoured in practice
 * (every probe of `minimax-m3` served the pinned upstream), so a pool median
 * there would price away the very benefit the pin exists to capture. Pinned
 * profiles are priced at their pin.
 *
 * A profile carrying `provider.only` instead (deepseek-v4-flash since
 * 2026-08-05) is NOT a pin and is enumerated normally — the enumeration is
 * simply bounded by the vetted pool, so the median is taken over the handful of
 * endpoints that can actually serve it. That is the right basis for a model
 * whose upstream is chosen live by `sort` rather than fixed.
 *
 * Resilient like `fetch-artificial-analysis.ts`: any failure simply omits that
 * profile, and the caller keeps the curated `assessment.pricing`. Never throws.
 */

/**
 * Profiles resolved concurrently. Each costs up to `MAX_POOL_SIZE` SEQUENTIAL
 * probes (enumeration is inherently serial — every step needs the previous
 * answer), so this is what keeps a full refresh in the low minutes rather than
 * the tens. Runs detached in the background, never on a request path.
 */
const PROBE_CONCURRENCY = 8;

/**
 * Upper bound on pool enumeration. Guards against a model with dozens of
 * reachable endpoints (GLM 5.2 lists 34) turning one refresh into hundreds of
 * calls — the median of the first 8, in OpenRouter's own preference order, is
 * representative enough.
 */
const MAX_POOL_SIZE = 6;

/**
 * Per-probe deadline. `max_tokens: 1` does NOT make a probe cheap in time — a
 * reasoning model reasons before emitting that token, and some upstreams take
 * a minute. Without a bound one slow provider stalls its whole batch.
 */
const PROBE_TIMEOUT_MS = 20_000;

const percentilesSchema = z.object({ p50: z.number().nullish() }).nullish();

const endpointSchema = z.object({
  provider_name: z.string(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().nullish(),
  }),
  latency_last_30m: percentilesSchema,
  throughput_last_30m: percentilesSchema,
});

const endpointsResponseSchema = z.object({
  data: z.object({ endpoints: z.array(endpointSchema) }),
});

const completionResponseSchema = z.object({ provider: z.string().nullish() });

export interface RoutedEndpoint {
  /**
   * The pinned upstream, or a `median of N` label when the price is the pool
   * median. Reported by `models:check --prices`, never shown to a user.
   */
  provider: string;
  /** That endpoint's live price, USD per 1M tokens. */
  pricing: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
  };
  /** p50 time to FIRST token, seconds. Null when OpenRouter has no sample. */
  ttftSeconds: number | null;
  /** p50 output tokens/second on that endpoint. Null when unsampled. */
  throughputTps: number | null;
}

export type RoutingLookup = ReadonlyMap<string, RoutedEndpoint>;

/** OpenRouter prices in USD per token; the registry works in USD per 1M. */
const perMTok = (raw: string): number => Number(raw) * 1_000_000;

/**
 * Ask for one token using the profile's REAL provider block and report which
 * upstream served it. Mirrors the `chat` envelope built by `settingsForRole` —
 * `require_parameters` + `zdr` + any `order` / `only` / `ignore` filter — because
 * those are exactly what narrow the pool. `sort` is deliberately absent even
 * though `settingsForRole` now forwards it: a sort only REORDERS a pool, so
 * sending it would bias every probe toward the same fast endpoint and defeat the
 * enumeration this function exists to perform.
 *
 * `exclude` carries the providers already enumerated, so repeated calls walk
 * the reachable pool in OpenRouter's own preference order until it 404s.
 */
const probeServingProvider = async (
  profile: ModelProfile,
  apiKey: string,
  exclude: readonly string[] = [],
): Promise<string | null> => {
  const { zdr, order, ignore, only, omitMaxTokens } =
    profile.assessment.provider;
  const skip = [...(ignore ?? []), ...exclude];
  const body: Record<string, unknown> = {
    model: profile.catalog.id,
    messages: [{ role: "user", content: "hi" }],
    provider: {
      require_parameters: true,
      zdr,
      ...(order ? { order: [...order] } : {}),
      // `only` narrows the reachable pool harder than anything else, so omitting
      // it would price a profile against endpoints it can never be served by —
      // exactly the class of error this module was written to catch. For a
      // profile carrying one, enumeration walks the VETTED pool and the median
      // is the median of what we actually pay.
      ...(only ? { only: [...only] } : {}),
      ...(skip.length > 0 ? { ignore: skip } : {}),
    },
  };
  // Same trap as the chat path: OpenAI's ZDR route is Azure, which advertises
  // `max_completion_tokens`, so sending `max_tokens` EMPTIES the pool (404)
  // instead of being ignored. See `ModelAssessment.provider.omitMaxTokens`.
  // Those profiles therefore probe UNCAPPED, which is why `resolveOne` only
  // ever probes them once.
  if (omitMaxTokens !== true) body.max_tokens = 1;

  // A capped probe still makes a reasoning model think before it emits its one
  // token, so a probe is not automatically fast. Bound it: a provider that
  // cannot answer "hi" inside the timeout is not one we want to price against,
  // and without this a single slow upstream stalls the whole refresh.
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const response = await fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: timeout,
  });
  if (!response.ok) return null;
  const parsed = completionResponseSchema.safeParse(await response.json());
  return parsed.success ? (parsed.data.provider ?? null) : null;
};

/** Per-endpoint price + measured latency/throughput for one model id. */
const fetchEndpoints = async (
  modelId: string,
  apiKey: string,
): Promise<z.infer<typeof endpointSchema>[] | null> => {
  const response = await fetch(
    `${OPENROUTER_API_BASE_URL}/models/${modelId}/endpoints`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!response.ok) return null;
  const parsed = endpointsResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.data.endpoints : null;
};

/** Median of a sample, averaging the middle pair on an even count. */
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (upper === undefined) return null;
  return sorted.length % 2 === 1 || lower === undefined
    ? upper
    : (lower + upper) / 2;
};

/**
 * Walk the reachable pool by re-probing with each found provider added to
 * `ignore`, until OpenRouter reports no endpoint left or the cap is hit.
 * Sequential by necessity — each step depends on the previous answer.
 */
const enumeratePool = async (
  profile: ModelProfile,
  apiKey: string,
): Promise<string[]> => {
  const pool: string[] = [];
  for (let attempt = 0; attempt < MAX_POOL_SIZE; attempt += 1) {
    const served = await probeServingProvider(profile, apiKey, pool);
    if (!served || pool.includes(served)) break;
    pool.push(served);
  }
  return pool;
};

const resolveOne = async (
  profile: ModelProfile,
  apiKey: string,
): Promise<RoutedEndpoint | null> => {
  const { order, omitMaxTokens } = profile.assessment.provider;
  const pinned = order !== undefined;
  // Two reasons to settle for ONE probe instead of enumerating:
  //  - `order` is a pin, and a pin is honoured in practice, so the pool median
  //    would price away the very benefit the pin exists to capture;
  //  - `omitMaxTokens` profiles cannot carry a token cap (Azure rejects
  //    `max_tokens`), so every probe of one is an UNCAPPED generation. Six of
  //    those per profile is a real bill for a metric nobody reads in dollars.
  const singleProbe = pinned || omitMaxTokens === true;
  const [pool, endpoints] = await Promise.all([
    singleProbe
      ? probeServingProvider(profile, apiKey).then((p) => (p ? [p] : []))
      : enumeratePool(profile, apiKey),
    fetchEndpoints(profile.catalog.id, apiKey),
  ]);
  if (pool.length === 0 || !endpoints) return null;

  const matched = pool.flatMap((name) => {
    const endpoint = endpoints.find((e) => e.provider_name === name);
    return endpoint ? [endpoint] : [];
  });
  if (matched.length === 0) return null;

  const inputPerMTok = median(matched.map((e) => perMTok(e.pricing.prompt)));
  const outputPerMTok = median(
    matched.map((e) => perMTok(e.pricing.completion)),
  );
  if (inputPerMTok === null || outputPerMTok === null) return null;
  // Endpoints without a cached rate are EXCLUDED rather than counted as zero:
  // a missing rate means "no discount published", and folding it in as 0 would
  // understate cost on exactly the term that dominates a Fretik turn.
  const cacheReadPerMTok = median(
    matched.flatMap((e) =>
      e.pricing.input_cache_read != null
        ? [perMTok(e.pricing.input_cache_read)]
        : [],
    ),
  );
  // OpenRouter reports latency in milliseconds, and leaves both axes null on
  // an endpoint it has not sampled in the last 30 minutes.
  const ttftMs = median(
    matched.flatMap((e) =>
      e.latency_last_30m?.p50 != null ? [e.latency_last_30m.p50] : [],
    ),
  );

  return {
    provider: singleProbe
      ? (pool[0] ?? "?")
      : `median of ${matched.length.toString()}`,
    pricing: {
      inputPerMTok,
      outputPerMTok,
      ...(cacheReadPerMTok !== null ? { cacheReadPerMTok } : {}),
    },
    ttftSeconds: ttftMs !== null ? ttftMs / 1000 : null,
    throughputTps: median(
      matched.flatMap((e) =>
        e.throughput_last_30m?.p50 != null ? [e.throughput_last_30m.p50] : [],
      ),
    ),
  };
};

/**
 * Resolve every profile's real routing. Returns an EMPTY map (never null) when
 * the key is unset or every probe fails, so the caller keeps one fallback path.
 */
export const fetchOpenRouterRouting = async (): Promise<RoutingLookup> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const lookup = new Map<string, RoutedEndpoint>();
  if (!apiKey) {
    console.warn(
      "[model-metrics] OPENROUTER_API_KEY unset — keeping curated prices",
    );
    return lookup;
  }

  const entries = Object.entries(MODEL_PROFILES);
  for (let index = 0; index < entries.length; index += PROBE_CONCURRENCY) {
    const batch = entries.slice(index, index + PROBE_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async ([key, profile]) => {
        try {
          const routed = await resolveOne(profile, apiKey);
          return { key, routed };
        } catch (error) {
          console.warn(
            `[model-metrics] routing probe failed for ${key} — keeping curated price`,
            error,
          );
          return { key, routed: null };
        }
      }),
    );
    for (const { key, routed } of resolved) {
      if (routed) lookup.set(key, routed);
    }
  }
  return lookup;
};
