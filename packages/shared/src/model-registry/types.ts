/**
 * Model engine — the transport-agnostic vocabulary.
 *
 * Two layers own model configuration, and the split is the whole point:
 *
 * - **Curation (TypeScript, `@fretik/ai` `lib/model-registry/profiles`).** What
 *   a model IS and how we decided to run it: tiers, native modalities, the
 *   reasoning envelope, the vetted upstream pool, the incident log. Changing it
 *   is a reviewed PR.
 * - **Live state (this package, `model_live_state`).** What is TRUE about it
 *   right now: which transport serves it, what the pool actually resolves to,
 *   the real context ceiling, today's price, whether a provider is quarantined.
 *   Changing it is a write — no deploy.
 *
 * Everything the nightly sync and the runtime breaker touch lives in the second
 * layer, because the first one cannot be edited from a running process. That
 * asymmetry is the bug this engine exists to fix: every provider exclusion used
 * to be a compile-time constant, so removing a provider that started corrupting
 * output meant a pull request and a redeploy — and two exclusions written that
 * way silently expired and had to be re-learned from a production incident.
 *
 * `@fretik/jobs` can import this package but NOT `@fretik/ai`, which is why the
 * sync reads models from the database rather than from the TypeScript registry.
 * The registry seeds the rows; it is never the job's source of truth.
 */

/**
 * Every transport the engine knows about. Two are implemented; the other two
 * are declared so the interfaces, the database enum and the admin surface are
 * shaped for them from the start rather than retrofitted.
 *
 * - `gateway` — Vercel AI Gateway (`@ai-sdk/gateway`). The default.
 * - `openrouter` — OpenRouter (`@openrouter/ai-sdk-provider`). Kept live and
 *   tested as the escape hatch: one write flips a model back to it.
 * - `scaleway` — Scaleway Generative APIs (OpenAI-compatible), for the day we
 *   offer EU-hosted inference.
 * - `custom` — a base URL + token supplied by the team, for self-hosted or
 *   on-premise endpoints.
 */
export const TRANSPORT_IDS = [
  "gateway",
  "openrouter",
  "scaleway",
  "custom",
] as const;
export type TransportId = (typeof TRANSPORT_IDS)[number];

/** Transports that have an adapter today. A row naming any other fails loudly. */
export const IMPLEMENTED_TRANSPORTS: readonly TransportId[] = [
  "gateway",
  "openrouter",
];

export const isTransportId = (value: string): value is TransportId =>
  (TRANSPORT_IDS as readonly string[]).includes(value);

/**
 * Upstream selection within a model, expressed once and translated per
 * transport. `only` is HARD (an empty intersection is an error, not a slow
 * answer), `order` is a preference, `ignore` is an exclusion.
 *
 * Provider names are stored NORMALISED (see `provider-names.ts`): the two APIs
 * spell the same company differently — `togetherai` / `Together`,
 * `bedrock` / `Amazon Bedrock`, `vertexAnthropic` / `Google` — and a pool that
 * silently fails to match is a pool that silently changes meaning.
 */
export interface ProviderPool {
  only?: string[];
  order?: string[];
  ignore?: string[];
  /**
   * How to order the pool. Set by the sync on the list it computes, so the
   * ordering travels with the membership instead of being restated per
   * profile — a pool with no ordering lets any member serve any turn, which is
   * what allows a known-bad host to answer as readily as a good one.
   *
   * Overrides the profile's own preference: a list derived tonight from
   * measured throughput knows more than an assessment written once. A profile
   * that sets `order` still wins outright, because an explicit order and a
   * sort cannot both apply — OpenRouter silently drops the sort when both are
   * present.
   */
  sort?: RoutingSort;
}

/** Pools differ per transport: the same model is served by different hosts. */
export type ProviderPoolByTransport = Partial<
  Record<TransportId, ProviderPool>
>;

/**
 * How to break ties inside the pool. Named for the PROPERTY, not for any
 * vendor's parameter: `throughput` is `sort: "throughput"` on OpenRouter and
 * `sort: "tps"` on the Gateway.
 */
export type RoutingSort = "price" | "throughput" | "latency";

/** Whether the transport is asked to place prompt-cache markers itself. */
export type CachingMode = "auto" | "manual" | "none";

/**
 * The complete routing intent for one call, before any transport dialect. An
 * adapter's whole job is to render this faithfully or to say it cannot.
 */
export interface RoutingPolicy {
  /** Route only through endpoints under a zero-retention agreement. */
  zdr: boolean;
  pool: ProviderPool;
  sort?: RoutingSort;
  caching: CachingMode;
  /**
   * Refuse endpoints that do not advertise every parameter we send. Load-bearing
   * on OpenRouter (without it a provider silently drops `tools` and the model
   * emits XML-looking plaintext through SSE); the Gateway has no equivalent, so
   * its adapter satisfies the intent by pool composition instead — the sync
   * excludes endpoints whose `supported_parameters` lack `tools`.
   */
  requireParameters: boolean;
  /** Serving precisions we accept, when the transport can express it. */
  quantizationFloor?: readonly string[];
  /** Drop `max_tokens` — some ZDR routes advertise only `max_completion_tokens`. */
  omitMaxTokens?: boolean;
}

/** USD per 1,000,000 tokens. Cache fields omitted when the endpoint has no rate. */
export interface PricingSnapshot {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

/**
 * One provider serving one model, as the catalogue APIs report it. Every field
 * past `provider` is optional because the two sources cover different columns
 * and neither is guaranteed: the Gateway has no quantization, OpenRouter has no
 * implicit-caching flag, and a provider with no recent traffic reports no
 * throughput at all.
 */
export interface EndpointStat {
  /** Normalised name — the join key across sources and the quarantine key. */
  provider: string;
  /** As the source spelled it, kept for operator-facing output. */
  displayName: string;
  /**
   * The token each transport's provider filter expects for this host, keyed by
   * transport. NOT interchangeable with `provider`, and that is the point:
   * `provider` answers "is this the company we quarantined", `wireNames`
   * answers "what must I type for this API to agree".
   *
   * They diverge on every host the two catalogues spell differently — measured
   * 2026-08-29: `together`/`togetherai`, `bedrock`/`amazon-bedrock`,
   * `claudeaws`/`claude-on-aws`, `google`/`google-ai-studio`. Sending an
   * identity where a wire name belongs fails in the two worst ways on offer:
   * the gateway rejects the request outright, and OpenRouter accepts the
   * unknown name and ignores it — turning a quarantine into a silent no-op.
   *
   * Filled per source, so a stat merged from both carries both and a transport
   * switch keeps routing to the hosts it was meant to.
   */
  wireNames: Partial<Record<TransportId, string>>;
  contextLength: number;
  maxCompletionTokens?: number;
  pricing: PricingSnapshot;
  supportedParameters: string[];
  supportsImplicitCaching?: boolean;
  /**
   * Whether this endpoint operates under a zero-retention agreement.
   *
   * The gateway publishes it per endpoint (`has_zdr`), which is better than the
   * alternative it replaced: the previous transport exposed nothing, so
   * eligibility had to be discovered by making a request and reading back which
   * host answered — 350 lines of probing that this one field removes.
   */
  hasZdr?: boolean;
  /** Only OpenRouter publishes this. `unknown` is a value, not an absence. */
  quantization?: string;
  uptime15m?: number;
  uptime1h?: number;
  uptime1d?: number;
  throughputP50?: number;
  throughputP95?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  /** Source-reported status; `0` is healthy on the Gateway. */
  status?: number;
}

/** The incident kinds the runtime detectors can raise. */
export const INCIDENT_KINDS = [
  /** Zero-width, bidi or fullwidth characters in emitted text. */
  "forbidden-codepoints",
  /** A `<think>` / `</think>` tag reached the content channel. */
  "think-leak",
  /** Text stopped mid-sentence on a turn that ended in tool calls. */
  "truncated-at-tool-call",
  /** A long generation ended on a non-model finish reason. */
  "upstream-cut",
  /** The turn watchdog drained a stream that stopped producing. */
  "stall",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/**
 * A provider removed from one model's pool. Quarantine is per (model,
 * provider): the same host can serve one model correctly and mangle another,
 * and the reverse claim would have cost us the whole pool more than once.
 */
export interface QuarantineEntry {
  provider: string;
  transport: TransportId;
  kind: IncidentKind;
  /** ISO timestamps — this is JSON in the column, not a typed row. */
  quarantinedAt: string;
  /** When the sync may re-probe. A failed probe extends it. */
  releaseAt: string;
  /** Incident ids that met the threshold, so the decision stays auditable. */
  incidentIds: string[];
  reason: string;
}

export type ModelHealth = "healthy" | "degraded" | "failing" | "unknown";

/**
 * `candidate` is a model the sync found and judged plausible; it is invisible
 * to teams until someone promotes it. Day-zero endpoints are measurably
 * unstable — tool-calling accuracy for one model spans 22 % to 37 % depending
 * on the host — so discovery is automatic and publication is not.
 */
export type ModelStatus = "published" | "candidate" | "retired";

export type DisabledReason = "cost" | "no-zdr" | "unavailable" | "policy";

export type PolicySeverity = "hard" | "soft";

export interface PolicyRuleResult {
  rule: string;
  passed: boolean;
  severity: PolicySeverity;
  /** Human-readable, with the measured value in it — this is what alerts quote. */
  detail: string;
}

export interface PolicyReport {
  /** False when any HARD rule failed. Soft failures inform health, not gating. */
  passed: boolean;
  hardFailures: number;
  softFailures: number;
  rules: PolicyRuleResult[];
  evaluatedAt: string;
  /** Providers dropped while building the allowed pool, with the reason. */
  excludedProviders: { provider: string; reason: string }[];
}

/** Artificial Analysis figures, all optional — the key is optional too. */
export interface AaMetrics {
  slug?: string;
  intelligenceIndex?: number;
  codingIndex?: number;
  agenticIndex?: number;
  mathIndex?: number;
  outputTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  timeToFirstAnswerTokenSeconds?: number;
  priceInputPerMTok?: number;
  priceOutputPerMTok?: number;
  fetchedAt?: string;
}

/**
 * A model profile derived entirely from catalogue facts, for models added by
 * command rather than by pull request. It carries just enough for the resolver
 * and the picker to treat the model like any other; a hand-written TypeScript
 * profile, when one exists, wins over it field by field.
 */
export interface DynamicProfile {
  displayName: string;
  family: string;
  tiers: ("flagship" | "workhorse" | "utility")[];
  contextLength: number;
  maxCompletionTokens?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  supportsReasoning: boolean;
  supportsTools: boolean;
  /** Derived from the catalogue tags, never guessed from the name. */
  derivedFrom: { source: string; at: string };
}

/**
 * One model's live row. `profileKey` is the same stable key teams, conversations
 * and workflows store, so this table joins to everything already persisted.
 */
export interface LiveModelState {
  profileKey: string;
  status: ModelStatus;
  transport: TransportId;
  enabled: boolean;
  disabledReason: DisabledReason | null;
  /** Per-transport model ids. The same model is `x-ai/grok-4.5` on one and
   *  `spacexai/grok-4.5` on the other; nothing derives one from the other. */
  modelIds: Partial<Record<TransportId, string>>;
  providerPool: ProviderPoolByTransport;
  quarantinedProviders: QuarantineEntry[];
  /** Vetted pool exhausted by quarantines — routing is open minus the bad hosts. */
  poolWidened: boolean;
  /** Nothing clean left anywhere: serve, but stop being anyone's first choice. */
  lastResort: boolean;
  /** Smallest context any allowed endpoint offers, minus a safety margin. */
  effectiveContextLength: number;
  effectiveMaxOutput: number | null;
  pricing: PricingSnapshot;
  creditMultiplier: number | null;
  health: ModelHealth;
  /** 0-100, composite. Drives `health`; kept so the grading stays inspectable. */
  healthScore: number | null;
  policyReport: PolicyReport | null;
  endpointStats: EndpointStat[];
  aaMetrics: AaMetrics | null;
  dynamicProfile: DynamicProfile | null;
  /**
   * Internal roles this model is bound to, written by the seed from
   * `ROLE_BINDINGS`. Non-empty means the fleet depends on it: the sync alerts
   * on such a model instead of disabling it, because disabling it would take
   * the chatbot down rather than degrade one team's choice.
   */
  boundRoles: string[];
  source: "seed" | "sync" | "admin";
  syncedAt: Date | null;
}
