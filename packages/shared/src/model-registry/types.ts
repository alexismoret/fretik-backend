/**
 * Model engine — the transport-agnostic vocabulary.
 *
 * ONE layer owns model configuration: `model_live_state`, this package's table.
 * A row says which transport serves a model, what its pool actually resolves
 * to, the real context ceiling, today's price, whether a provider is
 * quarantined — and, since the sync began refreshing it every pass, what the
 * catalogues say the model IS. `@fretik/ai` derives a profile from the row and
 * nothing else.
 *
 * It used to be two, with a hand-written TypeScript half that won outright for
 * the 22 models it named. The asymmetry was the bug this engine exists to fix:
 * that half could not be edited from a running process, so removing a provider
 * that had started corrupting output meant a pull request and a redeploy — and
 * two exclusions written that way silently expired and had to be re-learned
 * from a production incident. It was also, when finally measured, STALER than
 * the rows it overrode. Deleted 2026-08-30.
 *
 * Changing what a model IS is now a write, never a deploy. The one thing left
 * in code is which model serves which internal ROLE (`@fretik/ai`
 * `lib/model-registry/role-bindings.ts`), because no API publishes it.
 *
 * `@fretik/jobs` can import this package but NOT `@fretik/ai`, and that is no
 * longer a constraint worth working around: the database is the source of truth
 * for both.
 */

/**
 * Every transport the engine knows about. Two are implemented; the other two
 * are declared so the interfaces, the database enum and the admin surface are
 * shaped for them from the start rather than retrofitted.
 *
 * - `gateway` — Vercel AI Gateway (`@ai-sdk/gateway`). The default.
 * - `openrouter` — OpenRouter (`@openrouter/ai-sdk-provider`). Kept live and
 *   tested as the escape hatch: one write flips a model back to it.
 * - `scaleway` — Scaleway Generative APIs (OpenAI-compatible). EU-hosted, zero
 *   data retention by default, and a DIRECT provider rather than an aggregator:
 *   it serves each model itself, so its pool is one host and its catalogue
 *   takes three fetches to assemble.
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
  "scaleway",
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
  /**
   * The `tool_choice` modes this endpoint accepts, when a source reports them.
   *
   * Not the same question as `supportedParameters` containing `tools`: a host
   * can accept tool DEFINITIONS while refusing to be FORCED to call one. Two of
   * ours depend on forcing — the schema-guided extract engine and the tool-call
   * repair one-shot — and a host missing `required` does not fail there, it
   * quietly answers in prose instead. Absent means the source said nothing,
   * which must never be read as a refusal.
   */
  supportsToolChoice?: string[];
  uptime5m?: number;
  uptime15m?: number;
  uptime1h?: number;
  uptime1d?: number;
  throughputP50?: number;
  throughputP95?: number;
  latencyP50Ms?: number;
  /** OpenRouter's percentile objects carry p90, not p95 — kept apart so a p90 is never presented as the value p95 promises. */
  latencyP90Ms?: number;
  latencyP95Ms?: number;
  /** Source-reported status; `0` is healthy on the Gateway. */
  status?: number;
  /**
   * When the MEASUREMENT fields above (uptime*, throughput*, latency*) were
   * observed, ISO. Absent = never measured. Same contract as
   * `AaMetrics.fetchedAt`: a pass that could not measure keeps the previous
   * figures and this stamp says how old a kept figure is — without it, missing
   * and never-measured are indistinguishable, which is how the fleet ran for
   * days on percentiles nobody had ever fetched.
   */
  measuredAt?: string;
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
 * The kind a HAND quarantine files under when the operator names none.
 *
 * The column is typed to the five detector kinds, so someone acting on what
 * they saw still has to choose one. `upstream-cut` is the least specific claim
 * of the five — a generation that ended badly for a reason upstream — and the
 * reason text is where what actually happened is recorded. A sharper kind is
 * better when one fits: the kind is what the release re-probe and the alert
 * digest read back.
 */
export const DEFAULT_QUARANTINE_KIND: IncidentKind = "upstream-cut";

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
 *
 * A runtime tuple for the same reason `DISABLED_REASONS` is one: an operator
 * surface has to OFFER these, and a type alone cannot fill a filter or validate
 * a query parameter.
 */
export const MODEL_STATUSES = ["published", "candidate", "retired"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Who last wrote a `model_live_state` row — see `LiveModelState.source`. */
export type ModelStateSource = "seed" | "sync" | "admin" | "breaker";

/**
 * Who is performing a write, passed in rather than inferred.
 *
 * The breaker is the reason this exists: `quarantineProvider` serves both a
 * runtime detector and a person typing a command, so the function cannot know
 * from the inside which one called it. It used to stamp `admin` either way,
 * which was invisible while the only reader was a terminal and becomes a
 * falsehood the moment a screen puts a name beside the word.
 *
 * `operator` carries the id because an HTTP caller is one of several people
 * sharing this state; `cli` deliberately carries none, since a shell is
 * attributable by other means and inventing an id there would be worse than
 * admitting the gap.
 */
export type ModelWriteActor =
  | { kind: "breaker" }
  | { kind: "sync" }
  | { kind: "cli" }
  | { kind: "operator"; userId: string };

/**
 * The `source` column value for an actor.
 *
 * A person is a person whichever door they came through, so `cli` and
 * `operator` both record `admin`: the column answers "was this automatic",
 * and WHO exactly belongs in the action log, which holds the user id.
 */
export const sourceForActor = (actor: ModelWriteActor): ModelStateSource =>
  actor.kind === "cli" || actor.kind === "operator" ? "admin" : actor.kind;

/**
 * What quarantining an upstream actually did.
 *
 * Replaces a `boolean` that collapsed six outcomes into two values — and got
 * one of them wrong: the `last-resort` rung WRITES the row (`lastResort`,
 * `health`) and used to return `false`, so "returns whether anything changed"
 * was false for the single most serious branch. Callers read the difference
 * either by trusting a lie or, in the CLI's case, by re-reading the row and
 * fuzzy-matching the provider name.
 *
 * The variants are named after the rungs of the escalation ladder in
 * `services/model-registry/breaker.ts`, so the code and the comment that
 * explains it cannot drift apart.
 */
export type QuarantineOutcome =
  /** No `model_live_state` row: a raw model id from a bypass call site. */
  | { kind: "no-live-row" }
  | { kind: "already-quarantined"; entry: QuarantineEntry }
  /** Rung 1 — members left in the pool, so the host simply goes. */
  | {
      kind: "quarantined";
      entry: QuarantineEntry;
      remaining: number;
      /** Whether `remaining` counts the vetted list or every live endpoint. */
      remainingSource: "vetted" | "endpoints";
    }
  /** Rung 2 — vetted list exhausted, routing opened to the rest of the transport. */
  | { kind: "pool-widened"; entry: QuarantineEntry; remaining: number }
  /** Rung 3 — nothing clean here, the same model served from other hosts. */
  | {
      kind: "transport-switched";
      entry: QuarantineEntry;
      from: TransportId;
      to: TransportId;
    }
  /** Rung 4 — nothing anywhere: the host keeps serving, the MODEL steps down. */
  | { kind: "last-resort" };

/** What releasing an upstream actually did. Was `void`, which said nothing. */
export type ReleaseOutcome =
  | { kind: "no-live-row" }
  /**
   * Nothing to release here — and quarantine is recorded PER TRANSPORT, so
   * `elsewhere` carries the entries on the other ones. The caller used to have
   * to reconstruct that by diffing array lengths across a re-read.
   */
  | { kind: "not-quarantined"; elsewhere: readonly QuarantineEntry[] }
  | {
      kind: "released";
      entry: QuarantineEntry;
      /** Routing went back from open to the vetted list. */
      poolRenarrowed: boolean;
      lastResortLifted: boolean;
    };

/**
 * What a deliberate operator write did.
 *
 * These are RETURN types rather than thrown errors on purpose: two surfaces
 * consume them and only one prints English. A `throw new Error("…serves
 * internal role(s): chat…")` forces an HTTP layer to parse prose back into a
 * decision, and forces both surfaces to share one language.
 *
 * `throw` is kept for one thing only — a caller passing a value outside the
 * type, which is a programming error rather than a state the operator is in.
 */
export type SetTransportOutcome =
  | { kind: "unknown-model" }
  | { kind: "no-model-id"; transport: TransportId; available: TransportId[] }
  | { kind: "already-on-transport"; transport: TransportId }
  | { kind: "switched"; from: TransportId; to: TransportId };

export type SetEnabledOutcome =
  | { kind: "unknown-model" }
  | {
      kind: "updated";
      enabled: boolean;
      disabledReason: DisabledReason | null;
      /**
       * Carried so the caller can say what disabling does NOT do: `enabled`
       * gates team selection only, and a bound role resolves its model
       * directly, bypassing the check.
       */
      boundRoles: string[];
    };

export type PromoteOutcome =
  | { kind: "unknown-model" }
  | {
      kind: "already-published";
      enabled: boolean;
      disabledReason: "cost" | null;
    }
  | {
      kind: "promoted";
      enabled: boolean;
      /** `cost` means published but not PAID for — the two are separate decisions. */
      disabledReason: "cost" | null;
      pricing: PricingSnapshot;
      /** Running on catalogue facts alone: no reasoning envelope, no cache strategy. */
      catalogueDerivedOnly: boolean;
    };

export type RetireOutcome =
  | { kind: "unknown-model" }
  /**
   * Retiring a model an internal role runs on does not degrade one team's
   * choice, it takes those roles down. Rebinding is a reviewed pull request,
   * so this is a refusal rather than a warning.
   */
  | { kind: "refused-bound-roles"; roles: string[] }
  | { kind: "retired"; previousStatus: ModelStatus };

/**
 * Adding a model straight from a catalogue.
 *
 * The only operator action whose refusals are catalogue LOGIC rather than row
 * state, which is why it is a composed operation rather than a bare service
 * call: `addCatalogueModel` has no catalogue to consult and structurally
 * cannot express three of these four.
 */
export type AddFromCatalogueOutcome =
  /** `near` is a did-you-mean list the caller can render as suggestions. */
  | { kind: "not-in-catalogue"; catalogueSize: number; near: string[] }
  | { kind: "not-a-language-model" }
  | {
      kind: "key-exists";
      profileKey: string;
      status: ModelStatus;
      modelIds: string[];
    }
  /**
   * Endpoints exist but none survives the discovery policy, so there is
   * nothing to derive an honest context or price from. Refusing beats
   * inserting zeros: those two numbers are what compaction budgets against
   * and what credits bill off.
   */
  | {
      kind: "no-eligible-endpoint";
      endpointCount: number;
      excluded: { provider: string; reason: string }[];
    }
  /** `onConflictDoNothing` swallowed a concurrent insert of the same key. */
  | { kind: "insert-lost-race"; profileKey: string }
  | {
      kind: "added";
      profileKey: string;
      state: LiveModelState;
      endpoints: EndpointStat[];
      excluded: { provider: string; reason: string }[];
    };

export type AcknowledgeAlertOutcome =
  | { kind: "unknown-alert" }
  | { kind: "acknowledged"; alertKind: string; modelKey: string | null };

/**
 * One key of a batch threw, and the rest of the batch still ran.
 *
 * Deliberately NOT a variant of the operation outcomes: those describe
 * decisions the engine took, and "the database refused this UPDATE" is not one.
 * Keeping it separate means a caller reading `PromoteOutcome` still sees only
 * the states promotion can be in, while a batch envelope carries the failures
 * the batch itself has to survive.
 *
 * It exists because a batch that aborts on the seventh of twenty keys leaves
 * the operator not knowing where the boundary fell — strictly worse than either
 * extreme, since neither "all of them" nor "none of them" is true and nothing
 * on screen says which.
 */
export interface BulkFailure {
  kind: "failed";
  message: string;
}

/**
 * Something true after a write that the caller did not ask to change.
 *
 * The operator CLI's real value is not its verbs, it is the paragraph it
 * prints afterwards — "quarantines are KEPT, they are recorded per transport",
 * "`enabled` gates TEAM SELECTION only". A `POST` answering 204 throws all of
 * that away, so every write reports these instead.
 *
 * Structured and PARAMETERISED, never a bare string: a client handed only a
 * code would have to recompute the numbers from `before`/`after`, and several
 * of them are not derivable at all without duplicating a backend policy
 * constant (`PROMOTION_PRICE_CAPS`, `BREAKER_THRESHOLDS`, `QUARANTINE_DAYS`).
 * Same split the eligibility engine already makes between `unmet` (structure,
 * for the API) and `failed` (English, for logs and the CLI).
 *
 * Three admission rules keep this list from rotting into a dumping ground:
 *
 *  1. It states something about state the caller did not ask to change.
 *     "candidate → published" is not a consequence, it is `after`. "published
 *     but arrived DISABLED" is one.
 *  2. A client cannot derive it without a backend constant.
 *  3. An INVARIANT is page copy, not payload. "Takes effect on the next model
 *     construction, fleet-wide, with no deploy" is true of all eight writes;
 *     attaching it to every response makes it noise an operator learns to
 *     skip, which is exactly how a list like this stops being read.
 *
 * Consequently every variant below corresponds to a BRANCH the code actually
 * took. A code no branch produces cannot exist.
 */
export type Consequence =
  /** Published, but not paid for: the two are separate decisions. */
  | {
      code: "published-disabled-on-cost";
      inputPerMTok: number;
      outputPerMTok: number;
      capInputPerMTok: number;
      capOutputPerMTok: number;
    }
  /** No hand-written profile: no reasoning envelope, no cache strategy. */
  | { code: "catalogue-derived-profile-only" }
  | { code: "was-already-enabled" }
  /** Enabled, but teams still cannot select it — publication is a second step. */
  | { code: "still-unpublished"; status: ModelStatus }
  /** `enabled` gates team selection; a bound role resolves directly past it. */
  | { code: "roles-bypass-enabled"; roles: readonly string[] }
  /** A transport switch keeps them: quarantine is recorded per transport. */
  | { code: "quarantines-kept-per-transport"; kept: number }
  | { code: "pool-widened"; remaining: number }
  | { code: "transport-switched"; from: TransportId; to: TransportId }
  | { code: "now-last-resort" }
  /** What the breaker would have needed to file this by itself. */
  | {
      code: "breaker-would-need";
      kind: IncidentKind;
      generations: number;
      windowMinutes: number;
    }
  /** The date is a review trigger, not an amnesty: the sync re-probes on it. */
  | { code: "release-is-review-trigger"; releaseAt: string }
  | { code: "pool-renarrowed" }
  | { code: "last-resort-lifted" };

/**
 * A model row at the size an operator surface needs it.
 *
 * `LiveModelState` carries `endpointStats` (twenty objects on a busy model)
 * and a full `policyReport`; a write that answers with `before` and `after`
 * would ship both twice for no reader. These are the fields that actually
 * change, or that decide whether a change was safe.
 */
export interface ModelStateSummary {
  profileKey: string;
  status: ModelStatus;
  transport: TransportId;
  enabled: boolean;
  disabledReason: DisabledReason | null;
  health: ModelHealth;
  poolWidened: boolean;
  lastResort: boolean;
  activeQuarantineCount: number;
  boundRoles: string[];
}

/**
 * Why a model is not selectable, as the `disabled_reason` column spells it.
 *
 * The runtime tuple exists because an operator surface has to OFFER these — a
 * type alone cannot fill a dropdown or validate a request body. It lived in the
 * `model-admin` script for exactly that reason and had to be duplicated the
 * moment a second surface needed it.
 */
export const DISABLED_REASONS = [
  "cost",
  "no-zdr",
  "unavailable",
  "policy",
] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

export type PolicySeverity = "hard" | "soft";

/**
 * Why a rule the policy sets could not be evaluated.
 *
 * - `not-measured` — the data should exist and did not arrive this pass: a
 *   missing credential, a host with no recent traffic, an AA record we could
 *   not match. Repairable, so it costs health the way a soft failure does.
 * - `not-published-by-source` — no catalogue consulted for this row can ever
 *   publish the figure (Scaleway publishes no percentiles at all). Structural:
 *   visible in the report, free in the score, because nothing an operator does
 *   tonight can change it.
 */
export type PolicyRuleSkipReason = "not-measured" | "not-published-by-source";

export interface PolicyRuleResult {
  rule: string;
  passed: boolean;
  severity: PolicySeverity;
  /** Human-readable, with the measured value in it — this is what alerts quote. */
  detail: string;
  /**
   * Present when the rule could not be evaluated. `passed` is false, but a
   * skipped rule counts in NEITHER failure tally: absence of data is not
   * evidence of failure, and it must never read as success either — for months
   * these rules simply vanished from the report, so "we did not check" rendered
   * exactly like "everything passed".
   */
  skipped?: PolicyRuleSkipReason;
}

export interface PolicyReport {
  /** False when any HARD rule failed. Soft failures inform health, not gating. */
  passed: boolean;
  hardFailures: number;
  softFailures: number;
  rules: PolicyRuleResult[];
  /** Rules that could not be evaluated. Optional: reports graded before 2026-09-01 predate it. */
  skippedRules?: number;
  evaluatedAt: string;
  /** Providers dropped while building the allowed pool, with the reason. */
  excludedProviders: { provider: string; reason: string }[];
}

/**
 * Artificial Analysis figures, all optional — the key is optional too.
 *
 * NO PRICE AND NO THROUGHPUT live here, and adding either back would be a
 * regression rather than an enrichment: AA aggregates over hosts our pool never
 * routes to AND publishes one record per effort level, so both would describe a
 * model we do not run. Prices come from `PricingSnapshot` (the pool median) and
 * speeds from `EndpointStat` — both measured on our own routes.
 *
 * What belongs here is what AA alone can answer: the composite grades, and two
 * facts with no equivalent anywhere else. Time to the first ANSWER token,
 * because every endpoint API times the first token of any kind and cannot see
 * where reasoning ends. And the release date, for the models the gateway
 * catalogue does not list.
 */
export interface AaMetrics {
  slug?: string;
  intelligenceIndex?: number;
  codingIndex?: number;
  agenticIndex?: number;
  timeToFirstAnswerTokenSeconds?: number;
  /** `YYYY-MM-DD`. A fallback for `releasedAt`, which the catalogue owns. */
  releaseDate?: string;
  /**
   * Which AA index version graded this row (`"4.1"` on 2026-08-29). A floor
   * such as `intelligence >= 45` only means something within one version — AA
   * renumbers the fleet on a major bump, and without this the same constant
   * would quietly start selecting a different set of models.
   */
  indexVersion?: string;
  fetchedAt?: string;
}

/**
 * A model profile derived entirely from catalogue facts, for models added by
 * command rather than by pull request. It carries just enough for the resolver
 * and the picker to treat the model like any other; a hand-written TypeScript
 * profile, when one exists, wins over it field by field.
 */
/**
 * What a catalogue says about a model's thinking knob.
 *
 * Deliberately the upstream's own vocabulary, unfiltered: effort names arrive as
 * plain strings and are narrowed against the product's ladder where they are
 * consumed. A rung nobody models yet must reach the row rather than be dropped
 * at the boundary, or a catalogue growing a new level would look like a model
 * losing one.
 */
export interface CatalogueReasoning {
  /** Reasoning cannot be turned off — never send `none` to these. */
  mandatory: boolean;
  /** The exact ladder, upstream spelling. Absent ⇒ a budget, not a ladder. */
  supportedEfforts?: string[];
  /** Upstream's own default rung. */
  defaultEffort?: string;
  /** The model honours an explicit token budget for its thinking. */
  supportsMaxTokens?: boolean;
}

export interface DynamicProfile {
  displayName: string;
  family: string;
  contextLength: number;
  maxCompletionTokens?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  supportsReasoning: boolean;
  supportsTools: boolean;
  /**
   * The published reasoning contract — which depths this model accepts.
   *
   * Distinct from `supportsReasoning`, which only says the knob exists. This is
   * what a synthesised profile turns into a depth menu, so a model discovered
   * before this field existed offers no depth control until the next sync pass
   * refreshes its row.
   */
  reasoning?: CatalogueReasoning;
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
  /**
   * Upstream release date. Sortable, so the picker can answer "what is new"
   * without reading a jsonb column.
   */
  releasedAt: Date | null;
  /**
   * Which AA record grades this model, from curation. The sync matches on it
   * FIRST because AA publishes one record per effort level, so a name match
   * returns a rung we may not run.
   */
  aaSlug: string | null;
  dynamicProfile: DynamicProfile | null;
  /**
   * Internal roles this model is bound to, written by the seed from
   * `ROLE_BINDINGS`. Non-empty means the fleet depends on it: the sync alerts
   * on such a model instead of disabling it, because disabling it would take
   * the chatbot down rather than degrade one team's choice.
   */
  boundRoles: string[];
  /**
   * What last wrote this row.
   *
   * `breaker` exists because the column could not previously tell an operator
   * apart from a machine: `quarantineProvider` writes on every rung of its
   * escalation ladder and stamped `admin` whether a person ran `model-admin` or
   * a runtime detector tripped the circuit. Nobody noticed while the only
   * reader was a terminal; a screen that puts a name next to the word makes the
   * confusion visible. The writers are corrected where the caller's identity is
   * actually known — the breaker takes it from its caller, since the same
   * function serves both.
   */
  source: ModelStateSource;
  syncedAt: Date | null;
}
