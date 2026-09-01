import { createGateway } from "@ai-sdk/gateway";
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import {
  normalizeProviderName,
  toWireNames,
  wireNameIndex,
} from "@fretik/shared/model-registry/provider-names";
import type { EndpointStat } from "@fretik/shared/model-registry/types";
import { wrapLanguageModel } from "ai";
import type {
  GenerationReport,
  ReasoningRequest,
  TransportAdapter,
  TransportCapabilities,
  TransportRequest,
} from "./types";

/**
 * Vercel AI Gateway — the default transport.
 *
 * What it buys over the aggregator it replaces: no markup and no platform fee
 * on tokens (against 5.5 % on credit purchases), zero-data-retention per
 * request at no cost, prompt-cache markers placed by the gateway for providers
 * that need explicit ones, provider health folded into routing, and a
 * first-party AI SDK provider instead of a community package.
 *
 * The one dialect difference that shapes the code below: **there is no
 * `ignore`**. Exclusion is expressible only as an allow-list, so quarantining a
 * host means enumerating the others — which is why the live row keeps
 * `endpointStats` and why this adapter reads them.
 *
 * EVERY capability question is answered from the endpoints' own
 * `supported_parameters`, never from a table of families. The Gateway reports
 * that vocabulary uniformly (`reasoning`, `include_reasoning`, `tools`,
 * `max_tokens`, `temperature`, `stop`, `tool_choice`, verified across six
 * unrelated families on 2026-08-29) and it is the same vocabulary the previous
 * transport used, so a model family that ships next month is graded correctly
 * on the day it appears — no release, no edit here.
 */

const gatewayApiKey = process.env.AI_GATEWAY_API_KEY;

/**
 * Built lazily, never at import: a key needed only by the models actually
 * routed here must not stop the service — or a unit test — from booting. The
 * failure belongs on the first gateway call, where the error names the model.
 */
let client: ReturnType<typeof createGateway> | undefined;
const gateway = (): ReturnType<typeof createGateway> => {
  client ??= createGateway(
    gatewayApiKey === undefined ? {} : { apiKey: gatewayApiKey },
  );
  return client;
};

/** Whether a key is configured. Read by the probe and the admin CLI. */
export const gatewayConfigured = (): boolean => gatewayApiKey !== undefined;

/** Reset the memoized client. Tests only. */
export const resetGatewayClient = (): void => {
  client = undefined;
};

const advertisedByAll = (
  endpoints: readonly EndpointStat[],
  parameter: string,
): boolean =>
  endpoints.length > 0 &&
  endpoints.every((endpoint) =>
    endpoint.supportedParameters.includes(parameter),
  );

/** Quarantined hosts for this model on this transport, still in force. */
const quarantinedNow = (request: TransportRequest, now: Date): Set<string> =>
  new Set(
    (request.live?.quarantinedProviders ?? [])
      .filter(
        (entry) =>
          entry.transport === "gateway" &&
          new Date(entry.releaseAt).getTime() > now.getTime(),
      )
      .map((entry) => entry.provider),
  );

/**
 * The allow-list to send. With no `ignore` in the dialect, an exclusion is only
 * enforceable while the endpoint list is known — which the nightly sync keeps
 * on the row. Returning `undefined` means "say nothing and let the gateway
 * route on its own health signals", which is the right answer on a first boot
 * and the wrong one whenever a quarantine is in force; `capabilities()` reports
 * that gap rather than letting it pass unnoticed.
 *
 * Three things narrow the list, and until 2026-08-30 only the first did:
 *
 * 1. **Quarantines** — a host this engine measured as broken, per transport.
 * 2. **The profile's own `ignore`** — a host measured as broken by HAND, which
 *    is the same claim arrived at the same way and had no effect here at all.
 *    `openai.ts` excludes `fireworks` from `gpt-oss-20b`; on this transport
 *    Fireworks was free to serve it, and `capabilities()` reported the model as
 *    clean because it grades quarantines alone. The OpenRouter path has read
 *    this field since the pool existed (`resolve.ts`, `settingsForRole`), so the
 *    two transports disagreed about which hosts were allowed to serve a model.
 * 3. **`require_parameters`** — this dialect has no such flag, and the note on
 *    `RoutingPolicy` says the intent is satisfied "by pool composition instead".
 *    That holds once a sync has written a vetted pool, and not before: on a cold
 *    row `base` is every endpoint, tool-less hosts included, which is the exact
 *    failure `require_parameters` exists to prevent (a host that drops the
 *    parameter answers in XML-looking prose through SSE).
 */
const allowList = (
  request: TransportRequest,
  now: Date,
): {
  only: string[] | undefined;
  unresolved: string[];
  /** Identities left after every filter — what `capabilities` must grade. */
  allowed: string[];
  /** Hosts dropped for not advertising `tools`, for the scorecard. */
  toolless: string[];
  /** Hosts dropped by the profile's hand-measured exclusions. */
  excluded: string[];
} => {
  const quarantined = quarantinedNow(request, now);
  const vetted =
    request.live?.poolWidened === true
      ? undefined
      : request.live?.providerPool.gateway?.only;
  // Both sources, unioned: an exclusion recorded on the row and one written by
  // hand on the profile are the same claim reached the same way, and either
  // alone is enough. The row's is the one that survives — the sync carries it
  // forward every pass — which is what will let the profile's disappear.
  const curatedIgnore = new Set([
    ...(request.profile.assessment.provider.ignore ?? []),
    ...(request.live?.providerPool.gateway?.ignore ?? []),
  ]);
  // Only meaningful when we fell back to the raw endpoint list: a vetted pool
  // was already composed under the policy, while the raw list was composed by
  // nobody.
  const toolless =
    vetted === undefined
      ? new Set(
          request.endpoints
            .filter(
              (endpoint) => !endpoint.supportedParameters.includes("tools"),
            )
            .map((endpoint) => endpoint.provider),
        )
      : new Set<string>();
  const base = vetted ?? request.endpoints.map((endpoint) => endpoint.provider);
  const allowed = base.filter(
    (provider) =>
      !quarantined.has(provider) &&
      !curatedIgnore.has(provider) &&
      !toolless.has(provider),
  );
  // The pool stores IDENTITIES; this API accepts its own slugs, and a name it
  // does not know fails the whole request rather than being ignored — measured
  // 2026-08-29: `only: ["fretik-not-a-provider"]` came back "No available
  // providers match the 'only' filter". So a name we cannot spell is dropped,
  // never guessed, and `capabilities()` reports what was dropped.
  const { names, unresolved } = toWireNames(
    allowed,
    wireNameIndex(request.endpoints, "gateway"),
    "drop",
  );
  // An empty array is a 400. The breaker guarantees it never empties a pool, so
  // reaching zero here means we simply have no endpoint data yet.
  return {
    only: names.length > 0 ? names : undefined,
    unresolved,
    allowed,
    toolless: base.filter((provider) => toolless.has(provider)),
    excluded: base.filter((provider) => curatedIgnore.has(provider)),
  };
};

/**
 * Render the resolved reasoning envelope onto the wire.
 *
 * The shape is the unified `{ enabled, effort }` / `{ enabled, max_tokens }`
 * object — the vocabulary the Gateway advertises in `supported_parameters` and
 * the one the previous transport used, so a model that crosses keeps the exact
 * allowance it was measured with rather than inheriting a vendor default. It
 * travels as a service-owned gateway option, which the Gateway validates
 * against its own runtime schema.
 *
 * An unrecognised option fails LOUDLY with a 400 rather than quietly dropping
 * the budget, which is the failure mode worth having: `models:gateway-probe`
 * exercises it per model before any model is moved here.
 */
const reasoningWire = (
  reasoning: ReasoningRequest | undefined,
): Record<string, JSONValue> | undefined => {
  if (!reasoning) return undefined;
  if (reasoning.kind === "off") return { enabled: false, effort: "none" };
  if (reasoning.kind === "budget")
    return { enabled: true, max_tokens: reasoning.maxTokens };
  return { enabled: true, effort: reasoning.effort };
};

const capabilities = (request: TransportRequest): TransportCapabilities => {
  const now = new Date();
  const quarantined = quarantinedNow(request, now);
  const { only, unresolved, allowed, toolless, excluded } = allowList(
    request,
    now,
  );
  // What we will ACTUALLY route to. When the allow-list is sent, that is the
  // allowed set; when it is not, the gateway routes on its own signals and
  // everything reachable is in play. Grading the first set while sending the
  // second would be the same class of lie this file is being corrected for.
  const allowedSet = new Set(allowed);
  const reachable = request.endpoints.filter(
    (endpoint) => !quarantined.has(endpoint.provider),
  );
  const served =
    only === undefined
      ? reachable
      : reachable.filter((endpoint) => allowedSet.has(endpoint.provider));
  const gaps: string[] = [];

  const routable = reachable.length > 0;
  if (!routable) gaps.push("no endpoint data for this model on the gateway");

  const tools = advertisedByAll(served, "tools");
  if (routable && !tools) {
    const without = served
      .filter((endpoint) => !endpoint.supportedParameters.includes("tools"))
      .map((endpoint) => endpoint.provider);
    gaps.push(`endpoints without tool calling: ${without.join(", ")}`);
  }

  const needsReasoning =
    request.reasoning !== undefined && request.reasoning.kind !== "off";
  const reasoning = !needsReasoning || advertisedByAll(served, "reasoning");
  if (!reasoning)
    gaps.push("reasoning is steered here but not advertised by every endpoint");

  // Exclusions are enforceable only while we can name everyone else — and
  // "name" means in this API's own spelling, which only its endpoint data
  // supplies. A pool member with no spelling is silently absent from the
  // allow-list, so it is reported here rather than quietly narrowing routing.
  //
  // Both KINDS of exclusion are graded, not just quarantines: a hand-measured
  // `ignore` that cannot be expressed is exactly as lost as a quarantine that
  // cannot be, and it used to pass this check unmentioned.
  // Counted from the INTENT, not from what a filter managed to remove: with no
  // endpoint list nothing gets subtracted, so counting the applied exclusions
  // would report "nothing to express" exactly when we can express nothing.
  const toExclude =
    quarantined.size +
    (request.profile.assessment.provider.ignore?.length ?? 0) +
    (request.live?.providerPool.gateway?.ignore?.length ?? 0);
  const exclusions =
    (toExclude === 0 || request.endpoints.length > 0) &&
    unresolved.length === 0;
  if (toExclude > 0 && request.endpoints.length === 0)
    gaps.push(
      "an exclusion is in force but no endpoint list is known, so it cannot be expressed as an allow-list",
    );
  if (unresolved.length > 0)
    gaps.push(
      `pool members with no gateway spelling, dropped from the allow-list: ${unresolved.join(", ")}`,
    );
  if (toolless.length > 0)
    gaps.push(
      `hosts excluded for not advertising tool calling: ${toolless.join(", ")}`,
    );
  if (excluded.length > 0)
    gaps.push(`hosts excluded by the profile: ${excluded.join(", ")}`);

  return { routable, tools, reasoning, exclusions, gaps };
};

/**
 * Gateway options for one call, attached at CONSTRUCTION through the settings
 * object the provider merges into every request — so no call site changes.
 */
export const gatewayProviderOptions = (
  request: TransportRequest,
  now: Date = new Date(),
): Record<string, Record<string, JSONValue>> => {
  const { profile, binding } = request;
  const { only } = allowList(request, now);
  const reasoning = reasoningWire(request.reasoning);
  return {
    gateway: {
      ...(only ? { only } : {}),
      // Vocabularies differ per transport, so the mapping is spelled out rather
      // than passed through: the profiles ask for throughput, the gateway calls
      // that `tps`. The live pool's ordering wins over the profile's — it was
      // derived from measured throughput on the last pass, and the profile's
      // was written once.
      ...((request.live?.providerPool.gateway?.sort ??
        profile.assessment.provider.sort) === "throughput"
        ? { sort: "tps" as const }
        : {}),
      ...(profile.assessment.provider.zdr === true
        ? { zeroDataRetention: true }
        : {}),
      // Cache markers only for roles whose prompts repeat. `wrapCache` is the
      // registry's existing answer to that question, and on one-shot traffic a
      // cache WRITE is a small net cost with no read to repay it.
      ...(binding.wrapCache ? { caching: "auto" as const } : {}),
      ...(reasoning ? { reasoning } : {}),
    },
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const numberFrom = (value: unknown): number | undefined => {
  // The gateway reports cost as a DECIMAL STRING, not a number.
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const extractGatewayReport = (metadata: unknown): GenerationReport => {
  const gatewayMeta = asRecord(asRecord(metadata)?.gateway);
  if (!gatewayMeta) return {};
  const routing = asRecord(gatewayMeta.routing);
  const resolved = routing?.resolvedProvider ?? routing?.finalProvider;
  return {
    costUsd: numberFrom(gatewayMeta.cost),
    servingProvider:
      typeof resolved === "string"
        ? normalizeProviderName(resolved)
        : undefined,
    generationId:
      typeof gatewayMeta.generationId === "string"
        ? gatewayMeta.generationId
        : undefined,
  };
};

/**
 * The gateway provider takes a model id and nothing else — unlike the previous
 * transport, routing options travel per CALL rather than per model instance. A
 * `transformParams` middleware puts them back where the resolver expects them:
 * baked into the instance, invisible to every call site.
 *
 * Merging is namespace-wise and CALL-SITE-LAST, because a bare role that sets
 * its own options (vision, the compaction summariser) is making a deliberate
 * per-call choice that a construction-time default has no business overriding.
 */
const optionsMiddleware = (
  request: TransportRequest,
): LanguageModelV4Middleware => ({
  specificationVersion: "v4",
  transformParams: ({ params }) => {
    const merged: Record<string, Record<string, JSONValue>> = {};
    for (const [namespace, values] of Object.entries(
      gatewayProviderOptions(request),
    )) {
      merged[namespace] = values;
    }
    for (const [namespace, values] of Object.entries(
      params.providerOptions ?? {},
    )) {
      const existing = merged[namespace] ?? {};
      const overlay: Record<string, JSONValue> = { ...existing };
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) overlay[key] = value;
      }
      merged[namespace] = overlay;
    }
    return Promise.resolve({ ...params, providerOptions: merged });
  },
});

export const gatewayAdapter: TransportAdapter = {
  id: "gateway",
  buildModel: (request: TransportRequest): LanguageModelV4 =>
    wrapLanguageModel({
      model: gateway()(request.modelId),
      middleware: optionsMiddleware(request),
    }),
  capabilities,
  extractReport: extractGatewayReport,
};
