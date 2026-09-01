import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { normalizeProviderName } from "@fretik/shared/model-registry/provider-names";
import { wrapLanguageModel } from "ai";
import type {
  CallUsage,
  GenerationReport,
  ReasoningRequest,
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
 * Render the resolved reasoning envelope onto the wire.
 *
 * Plain OpenAI-compatible chat completions have exactly ONE reasoning knob,
 * `reasoning_effort`, and no notion of a token budget. So the two shapes of
 * `ReasoningRequest` land very differently here, and saying which is the whole
 * point of this function rather than passing the envelope through:
 *
 * - an EFFORT ladder maps straight onto the knob;
 * - a BUDGET does not map at all, and the nearest effort is not a substitute.
 *   A budget is a hard allowance, an effort is a hint the model may ignore —
 *   swapping one for the other is the "quietly downgrade" `capabilities` exists
 *   to prevent, and that allowance is the only thing that has kept some models
 *   from spending an entire turn thinking (38 679 reasoning tokens in one step);
 * - OFF is expressible only when the model's own published ladder carries a
 *   `none` rung. Sending a value the pool never advertised is what empties a
 *   pool instead of dropping a field.
 *
 * `reasoningEffort` is a free-form string in the provider package's option
 * schema and reaches the body verbatim as `reasoning_effort`, so a rung this
 * codebase gains later needs no change here.
 */
const reasoningWire = (
  reasoning: ReasoningRequest | undefined,
  profile: TransportRequest["profile"],
): string | undefined => {
  if (reasoning === undefined) return undefined;
  if (reasoning.kind === "effort") return reasoning.effort;
  if (reasoning.kind === "budget") return undefined;
  const ladder = profile.catalog.reasoning?.supportedEfforts;
  return ladder?.includes("none") === true ? "none" : undefined;
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

  // Two independent ways to lose a reasoning envelope, and both used to pass
  // this check: the MODEL may not advertise the parameter, and the DIALECT may
  // not be able to spell the request. Grading only the first is what let a
  // budget — or an `off` on a model with no `none` rung — reach `buildModel`
  // and be dropped there with no symptom at all.
  const needsReasoning =
    request.reasoning !== undefined && request.reasoning.kind !== "off";
  const reasoning =
    (!needsReasoning || advertised("reasoning")) &&
    (request.reasoning === undefined ||
      reasoningWire(request.reasoning, request.profile) !== undefined);
  if (needsReasoning && !advertised("reasoning")) {
    gaps.push("reasoning is steered here but this model advertises none");
  }
  if (request.reasoning?.kind === "budget") {
    gaps.push(
      "a reasoning token budget cannot be expressed here — this dialect has an effort ladder and no allowance",
    );
  }
  if (
    request.reasoning?.kind === "off" &&
    reasoningWire(request.reasoning, request.profile) === undefined
  ) {
    gaps.push(
      "reasoning cannot be turned off here — this model publishes no `none` rung",
    );
  }

  // Caching here is automatic and unaddressable: the platform caches prefixes
  // on its own and reports no split, so a profile that expects to PLACE
  // breakpoints gets neither its markers nor the gateway's `caching: "auto"`
  // stand-in. Nothing is broken by that — the cache still works — but the
  // profile asked for something this transport cannot do, and an operator
  // comparing transports deserves to read it rather than infer it from a bill.
  if (request.profile.assessment.cache.strategy === "explicit-breakpoints") {
    gaps.push(
      "cache breakpoints cannot be placed here — this platform caches prefixes on its own and reports no split",
    );
  }

  gaps.push(
    "one host serves every model here, so a quarantine would remove the model rather than reroute it",
  );

  return { routable: true, tools, reasoning, exclusions: false, gaps };
};

/**
 * Provider options for one call, attached at CONSTRUCTION the way the gateway
 * adapter attaches its own — so no call site changes and a model carries the
 * allowance its role resolved wherever it is built.
 *
 * The namespace is the provider NAME (`scaleway`): the provider package spreads
 * `providerOptions[name]` into the request body and maps `reasoningEffort` onto
 * `reasoning_effort`.
 *
 * Exported for the same reason its gateway twin is — it is the only place that
 * says what leaves the process, and a test that cannot read it can only assert
 * that a model was built.
 */
export const scalewayProviderOptions = (
  request: TransportRequest,
): Record<string, Record<string, JSONValue>> => {
  const effort = reasoningWire(request.reasoning, request.profile);
  return effort === undefined ? {} : { scaleway: { reasoningEffort: effort } };
};

const optionsMiddleware = (
  request: TransportRequest,
): LanguageModelV4Middleware => ({
  specificationVersion: "v4",
  transformParams: ({ params }) => {
    const merged: Record<string, Record<string, JSONValue>> = {
      ...scalewayProviderOptions(request),
    };
    // Call-site options win: a bare role setting its own is making a deliberate
    // per-call choice a construction-time default has no business overriding.
    for (const [namespace, values] of Object.entries(
      params.providerOptions ?? {},
    )) {
      const overlay: Record<string, JSONValue> = { ...merged[namespace] };
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) overlay[key] = value;
      }
      merged[namespace] = overlay;
    }
    return Promise.resolve({ ...params, providerOptions: merged });
  },
});

/**
 * No cost on the wire, but the serving host is never in doubt.
 *
 * Measured 2026-08-30 over the SDK and over a raw HTTP call: the response body
 * carries `{choices, created, id, model, object, service_tier,
 * system_fingerprint, usage}`, the `usage` block is `{prompt_tokens,
 * completion_tokens, total_tokens, prompt_tokens_details: null}`, and the only
 * quantitative headers are the four `x-ratelimit-*`. No cost anywhere, so
 * `providerMetadata` comes back as a bare `{scaleway: {}}`.
 *
 * `costUsd` therefore stays absent — the price is supplied by
 * `estimateCostUsd` below and labelled as derived, because everything
 * downstream reads `costUsd` as measured and inventing a figure here would be
 * worse than none.
 *
 * `servingProvider` is a different question with a definite answer. This is a
 * DIRECT provider: one host, no routing, so naming it is reading the transport
 * rather than guessing at a measurement. Leaving it absent — as this did until
 * 2026-09-01 — made every Scaleway call unattributable, which is not a gap in
 * a dashboard but a hole in the safety net: the breaker quarantines a
 * PROVIDER, so a finding it cannot attribute is dropped, and Scaleway was the
 * one transport whose corruption could never be caught.
 */
/**
 * GATED on the `scaleway` namespace being present, exactly as its two siblings
 * gate on theirs. The readers try the extractors in turn and take the first
 * answer, so an unconditional one would catch every call the other transports
 * failed to attribute and file it against a host that never saw it —
 * misattribution being strictly worse than no attribution, since a quarantine
 * acts on the name.
 */
export const extractScalewayReport = (metadata: unknown): GenerationReport =>
  typeof metadata === "object" && metadata !== null && "scaleway" in metadata
    ? { servingProvider: SCALEWAY_PROVIDER }
    : {};

const extractReport = (metadata: unknown): GenerationReport =>
  extractScalewayReport(metadata);

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
    wrapLanguageModel({
      model: scalewayClient().chatModel(request.modelId),
      middleware: optionsMiddleware(request),
    }),
  capabilities,
  extractReport,
  estimateCostUsd,
};
