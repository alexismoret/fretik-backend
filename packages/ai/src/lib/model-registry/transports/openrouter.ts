import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  normalizeProviderList,
  normalizeProviderName,
  toWireNames,
  wireNameIndex,
} from "@fretik/shared/model-registry/provider-names";
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from "@openrouter/ai-sdk-provider";
import type { ModelProfile, RoleBinding } from "../types";
import type {
  GenerationReport,
  TransportAdapter,
  TransportCapabilities,
  TransportRequest,
} from "./types";

/**
 * OpenRouter — the previous default, kept as a live, exercised escape hatch.
 *
 * It stays for three reasons that are not sentiment. It serves models the
 * Gateway does not carry in the version we run (`mistral-small-2603` and
 * `ministral-8b-2512`: the Gateway's `mistral-small` is the 2024 model at a
 * quarter of the context). It is the only source of per-endpoint QUANTIZATION,
 * which the nightly sync uses to enrich the other transport's data. And it is
 * the rollback: one write moves a model back here, which is only true as long
 * as the path keeps running in production rather than rotting in a branch.
 *
 * The routing envelope itself is INJECTED rather than rebuilt. `settingsForRole`
 * carries several years of measured decisions — why `require_parameters` is
 * load-bearing, why a quantization floor empties one pool and saves another, why
 * `order` and `sort` cannot be combined — and 59 tests pin its output byte for
 * byte. Rewriting it to move it would have been a rewrite of that evidence.
 */

const apiKey = process.env.OPENROUTER_API_KEY;

/**
 * Built lazily so an empty environment still boots. The service's own boot
 * check for this key lives in `resolve.ts`, which is where a missing key must
 * be loud.
 */
let client: ReturnType<typeof createOpenRouter> | undefined;
export const openrouterClient = (): ReturnType<typeof createOpenRouter> => {
  client ??= createOpenRouter(apiKey === undefined ? {} : { apiKey });
  return client;
};

export type EnvelopeForRole = (
  binding: RoleBinding,
  profile: ModelProfile,
) => OpenRouterChatSettings | undefined;

/** Quarantined hosts for this model on this transport, still in force. */
const quarantinedNow = (request: TransportRequest, now: Date): string[] => [
  ...new Set(
    (request.live?.quarantinedProviders ?? [])
      .filter(
        (entry) =>
          entry.transport === "openrouter" &&
          new Date(entry.releaseAt).getTime() > now.getTime(),
      )
      .map((entry) => entry.provider),
  ),
];

/**
 * Fold live state into the role's envelope.
 *
 * Two edits, and only these two: quarantined hosts are appended to `ignore`
 * (this dialect HAS an exclusion list, so the removal is exact and needs no
 * endpoint enumeration), and a pool the breaker had to widen drops its `only`
 * so routing can reach beyond an exhausted vetted list.
 *
 * Provider names are normalised on the way out. The profiles were written by
 * hand against a catalogue that spells hosts inconsistently — `deepinfra` in
 * one pool, `DeepInfra` in another, `CoreWeave` in a third — and a quarantine
 * that does not match its pool entry is a quarantine that does nothing.
 */
export const applyLiveState = (
  settings: OpenRouterChatSettings | undefined,
  request: TransportRequest,
  now: Date = new Date(),
): OpenRouterChatSettings | undefined => {
  const quarantined = quarantinedNow(request, now);
  const widened = request.live?.poolWidened === true;
  const index = wireNameIndex(request.endpoints, "openrouter");
  // Identities in, this API's slugs out. `keep` rather than `drop`: an
  // unrecognised name here is DISCARDED rather than refused, so passing the
  // identity through costs nothing and may still match, while dropping it
  // would silently lift the quarantine. `capabilities()` reports the ones we
  // could not translate.
  const quarantinedWire = toWireNames(quarantined, index, "keep").names;
  const livePool = request.live?.providerPool.openrouter;
  const provider = settings?.provider ?? {};

  // The membership the request should carry, in order of authority. The live
  // pool comes FIRST because it is recomputed nightly from measured endpoints,
  // while a profile's list was written once by hand — and for 20 of 22 models
  // there was no hand-written list at all, which left routing free to pick any
  // host including ones a later incident had discredited.
  const poolSource = widened ? undefined : (livePool?.only ?? provider.only);
  const onlyWire = poolSource
    ? // Normalised to identities before translation: the hand-written lists
      // spell hosts inconsistently (`DeepInfra` in one, `deepinfra` in
      // another), and two spellings of one host would survive as two members
      // that a quarantine matches neither of.
      toWireNames(normalizeProviderList(poolSource), index, "drop").names
    : undefined;

  // Quarantined members are removed HERE, once, rather than in each branch
  // below. Doing it per branch is how the bare-role path came to send a pool
  // that still contained the host it was excluding.
  const allowed =
    widened || onlyWire === undefined
      ? undefined
      : onlyWire.filter((name) => !quarantinedWire.includes(name));

  // `order` and `sort` are mutually exclusive here: OpenRouter treats an
  // explicit order as the entire preference and silently drops the sort. A
  // profile that pins an order has a measured reason to, so it wins whole.
  const sort =
    provider.order === undefined
      ? (livePool?.sort ?? provider.sort)
      : undefined;

  const ignore = [
    ...new Set([
      ...toWireNames(
        normalizeProviderList(provider.ignore ?? []),
        index,
        "keep",
      ).names,
      ...quarantinedWire,
    ]),
  ];

  // A bare role sends no provider block at all. It still has to honour a
  // quarantine and still benefits from the vetted pool, so one is built for it
  // — but only when there is something to say.
  if (!settings) {
    const bare = {
      ...(ignore.length > 0 ? { ignore } : {}),
      ...(allowed && allowed.length > 0 ? { only: allowed } : {}),
      ...(sort === undefined ? {} : { sort }),
    };
    return Object.keys(bare).length > 0 ? { provider: bare } : undefined;
  }

  return {
    ...settings,
    provider: {
      ...provider,
      ...(ignore.length > 0 ? { ignore } : {}),
      ...(sort === undefined ? {} : { sort }),
      // An empty result is sent as `undefined`, never as `[]`: an empty
      // allow-list means "nothing may serve this", which is an outage.
      only: allowed && allowed.length > 0 ? allowed : undefined,
    },
  };
};

const capabilities = (request: TransportRequest): TransportCapabilities => {
  const quarantined = new Set(quarantinedNow(request, new Date()));
  const reachable = request.endpoints.filter(
    (endpoint) => !quarantined.has(endpoint.provider),
  );
  const gaps: string[] = [];

  // Unlike the gateway, this dialect can exclude by name, so a quarantine holds
  // whether or not we have endpoint data.
  const exclusions = true;
  // With no endpoint data the catalogue's own parameter list is the fallback
  // answer — the profile mirrors it verbatim for exactly this reason.
  const advertised =
    reachable.length > 0
      ? (parameter: string): boolean =>
          reachable.every((endpoint) =>
            endpoint.supportedParameters.includes(parameter),
          )
      : (parameter: string): boolean =>
          request.profile.catalog.supportedParameters.includes(parameter);

  const tools = advertised("tools");
  if (!tools) gaps.push("tool calling is not advertised by every endpoint");

  const needsReasoning =
    request.reasoning !== undefined && request.reasoning.kind !== "off";
  const reasoning = !needsReasoning || advertised("reasoning");
  if (!reasoning)
    gaps.push("reasoning is steered here but not advertised by every endpoint");

  return { routable: true, tools, reasoning, exclusions, gaps };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

export const extractOpenRouterReport = (
  metadata: unknown,
): GenerationReport => {
  const meta = asRecord(asRecord(metadata)?.openrouter);
  if (!meta) return {};
  const cost = asRecord(meta.usage)?.cost;
  return {
    costUsd:
      typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
    servingProvider:
      typeof meta.provider === "string"
        ? normalizeProviderName(meta.provider)
        : undefined,
  };
};

/**
 * Build the adapter around a role-envelope builder. The injection keeps the
 * envelope where its tests and its history are, without this module having to
 * import the resolver that imports it.
 */
export const createOpenRouterAdapter = (
  envelopeForRole: EnvelopeForRole,
): TransportAdapter => ({
  id: "openrouter",
  buildModel: (request: TransportRequest): LanguageModelV4 => {
    const settings = applyLiveState(
      envelopeForRole(request.binding, request.profile),
      request,
    );
    return settings
      ? openrouterClient().chat(request.modelId, settings)
      : openrouterClient().chat(request.modelId);
  },
  capabilities,
  extractReport: extractOpenRouterReport,
});
