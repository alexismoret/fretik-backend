import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { normalizeProviderName } from "@fretik/shared/model-registry/provider-names";
import type {
  CallUsage,
  GenerationReport,
  TransportAdapter,
  TransportCapabilities,
  TransportRequest,
} from "./types";

/**
 * Scaleway Generative APIs — EU-hosted inference, served direct.
 *
 * The first DIRECT provider in the registry, and everything that distinguishes
 * it from the two aggregators follows from that:
 *
 * - **There is no pool to steer.** `only`, `ignore`, `sort` and
 *   `require_parameters` all answer the question "which of these competing
 *   hosts should serve this?", and here there is one host. So the adapter sends
 *   no routing envelope at all — not an empty one, which would be a claim.
 * - **A quarantine cannot be expressed, and must not pretend to be.**
 *   `capabilities.exclusions` is `false`, which is not a shortcoming to work
 *   around: excluding the only host that serves a model does not reroute it, it
 *   removes it. The breaker already refuses to empty a pool, so the honest verb
 *   for a failing Scaleway model is disabling the MODEL, and reporting the gap
 *   is what lets the operator surface say so.
 * - **Zero data retention is the platform's default**, stated once rather than
 *   negotiated per route, which is the property that makes this transport worth
 *   having for teams with a sovereignty requirement.
 *
 * The wire dialect is plain OpenAI-compatible chat completions, so the provider
 * package does the work and this file is mostly the three honest answers above.
 */

const apiKey = process.env.SCW_SECRET_KEY;
const projectId = process.env.SCW_PROJECT_ID;

/**
 * The base URL is PROJECT-SCOPED. The bare `api.scaleway.ai/v1` answers 403
 * with a valid key, which reads as a permissions problem and is not one —
 * verified 2026-08-30, before and after enabling API access on the account.
 */
const baseURL = (project: string) => `https://api.scaleway.ai/${project}/v1`;

/**
 * Built lazily so an empty environment still boots — the same rule the other
 * adapters follow. A model that resolves here without credentials fails on the
 * call rather than at import, which keeps a missing key from taking down a
 * process that was never going to route through Scaleway.
 */
let client: ReturnType<typeof createOpenAICompatible> | undefined;
const scalewayClient = (): ReturnType<typeof createOpenAICompatible> => {
  if (apiKey === undefined || projectId === undefined) {
    throw new Error(
      "Scaleway transport requires SCW_SECRET_KEY and SCW_PROJECT_ID",
    );
  }
  client ??= createOpenAICompatible({
    name: "scaleway",
    baseURL: baseURL(projectId),
    apiKey,
  });
  return client;
};

/**
 * What this transport can carry.
 *
 * Read from the endpoint the sync recorded rather than assumed, for the same
 * reason the other adapters do it: the answer has to stay right for a model
 * that did not exist when this file was written. With no endpoint data there is
 * nothing to read, and the profile's own catalogue is the fallback.
 */
const capabilities = (request: TransportRequest): TransportCapabilities => {
  const gaps: string[] = [];
  const advertised =
    request.endpoints.length > 0
      ? (parameter: string): boolean =>
          request.endpoints.every((endpoint) =>
            endpoint.supportedParameters.includes(parameter),
          )
      : (parameter: string): boolean =>
          request.profile.catalog.supportedParameters.includes(parameter);

  const tools = advertised("tools");
  if (!tools) gaps.push("tool calling is not advertised for this model");

  const needsReasoning =
    request.reasoning !== undefined && request.reasoning.kind !== "off";
  const reasoning = !needsReasoning || advertised("reasoning");
  if (!reasoning) {
    gaps.push("reasoning is steered here but this model advertises none");
  }

  gaps.push(
    "one host serves every model here, so a quarantine would remove the model rather than reroute it",
  );

  return { routable: true, tools, reasoning, exclusions: false, gaps };
};

/**
 * Nothing to extract, verified rather than assumed.
 *
 * Measured 2026-08-30 over the SDK and over a raw HTTP call: the response body
 * carries `{choices, created, id, model, object, service_tier,
 * system_fingerprint, usage}`, the `usage` block is `{prompt_tokens,
 * completion_tokens, total_tokens, prompt_tokens_details: null}`, and the only
 * quantitative headers are the four `x-ratelimit-*`. No cost anywhere, so
 * `providerMetadata` comes back as a bare `{scaleway: {}}`.
 *
 * Returning `{}` is what keeps the reader moving on to the adapter that does
 * know. The price is supplied instead by `estimateCostUsd` below, which is
 * labelled as derived — inventing a figure HERE would be worse than none,
 * because everything downstream reads `costUsd` as measured.
 */
const extractReport = (): GenerationReport => ({});

/**
 * The published rate for this model, per million tokens.
 *
 * Read from the endpoint the sync recorded — Scaleway's own catalogue price,
 * converted once at the source — and never from another transport's. The pool
 * median is the fallback, and for a one-host pool the two are the same number.
 */
const rateFor = (
  request: TransportRequest,
): { input: number; output: number } | undefined => {
  const pricing = request.endpoints[0]?.pricing ?? request.live?.pricing;
  if (pricing === undefined) return undefined;
  const { inputPerMTok, outputPerMTok } = pricing;
  if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) {
    return undefined;
  }
  return { input: inputPerMTok, output: outputPerMTok };
};

/**
 * What the call cost, at Scaleway's published rate.
 *
 * An UPPER BOUND rather than the bill, and the gap has one named cause:
 * Scaleway caches prefixes automatically — its documentation quotes a 50–90 %
 * hit ratio on conversational workloads — and bills cache reads at a lower rate
 * for the models that have one (`deepseek-v4-flash-0731`: $0.096 against $0.48
 * per MTok). It reports `prompt_tokens_details: null`, so the split is not
 * observable from here and every input token is priced at list. For a model
 * with no cache rate the figure is exact.
 *
 * Erring high is the right direction for the one decision this feeds. A cost
 * dashboard that overstates prompts a look at a bill; one that understates
 * makes a transport look cheaper than it is, which is how it gets chosen.
 */
const estimateCostUsd = (
  request: TransportRequest,
  usage: CallUsage,
): number | undefined => {
  const rate = rateFor(request);
  if (rate === undefined) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input === 0 && output === 0) return undefined;
  return (input * rate.input + output * rate.output) / 1_000_000;
};

/** The one host, under its normalised identity — the same name a pool would use. */
export const SCALEWAY_PROVIDER = normalizeProviderName("Scaleway");

export const scalewayAdapter: TransportAdapter = {
  id: "scaleway",
  buildModel: (request: TransportRequest): LanguageModelV4 =>
    scalewayClient().chatModel(request.modelId),
  capabilities,
  extractReport,
  estimateCostUsd,
};
