import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  AaMetrics,
  DisabledReason,
  DynamicProfile,
  EndpointStat,
  IncidentKind,
  ModelHealth,
  ModelStateSource,
  ModelStatus,
  PolicyReport,
  PricingSnapshot,
  ProviderPoolByTransport,
  QuarantineEntry,
  TransportId,
} from "../../model-registry/types";
import { user } from "./auth-schema";

/**
 * Live model state — the half of model configuration a running process may
 * change. The other half (what a model IS, and why we chose to run it that way)
 * stays in the TypeScript registry under `@fretik/ai`, where changing it is a
 * reviewed pull request.
 *
 * The split exists because every provider exclusion used to be a compile-time
 * constant. When an upstream started inserting zero-width characters next to
 * numbers, removing it took a pull request and a redeploy — and two exclusions
 * written that way quietly expired and had to be relearned from a production
 * incident. Anything the nightly sync or the runtime breaker decides lands
 * here instead.
 *
 * Global infra state: no org/team scoping, no SQL-tool visibility (RLS enabled
 * with no policy, like `worker_cursors`).
 */
export const modelLiveState = pgTable("model_live_state", {
  /** Registry profile key — the same value teams, conversations and workflows store. */
  profileKey: varchar("profile_key", { length: 64 }).primaryKey(),

  /** `published` is visible to teams; `candidate` is discovered but unpublished. */
  status: varchar("status", { length: 16 })
    .$type<ModelStatus>()
    .default("published")
    .notNull(),

  /**
   * Which adapter serves this model. Flipping it is the rollback: one write
   * moves a model off a transport without a deploy, and the escape hatch stays
   * exercised because other models keep using it.
   */
  transport: varchar("transport", { length: 16 })
    .$type<TransportId>()
    .default("gateway")
    .notNull(),

  enabled: boolean("enabled").default(true).notNull(),
  disabledReason: varchar("disabled_reason", {
    length: 32,
  }).$type<DisabledReason>(),

  /**
   * Model id per transport. Nothing derives one from the other: the same model
   * is `x-ai/grok-4.5` on OpenRouter and `spacexai/grok-4.5` on the Gateway,
   * `z-ai/glm-5.2` and `zai/glm-5.2`, `cohere/rerank-4-fast` and
   * `cohere/rerank-v4-fast`. Verified against both catalogues 2026-08-29.
   */
  modelIds: jsonb("model_ids")
    .$type<Partial<Record<TransportId, string>>>()
    .default({})
    .notNull(),

  /**
   * Vetted upstream pool per transport, seeded from the profile. Per transport
   * because the same model is served by different hosts on each: the vetted
   * DeepSeek pool has four members on OpenRouter and three of them exist on the
   * Gateway, whose own catalogue additionally offers hosts we have measured as
   * unusable.
   */
  providerPool: jsonb("provider_pool")
    .$type<ProviderPoolByTransport>()
    .default({})
    .notNull(),

  /** Providers the breaker pulled out, with the evidence and a release date. */
  quarantinedProviders: jsonb("quarantined_providers")
    .$type<QuarantineEntry[]>()
    .default([])
    .notNull(),

  /**
   * The vetted pool was exhausted by quarantines, so routing is temporarily
   * open to every endpoint the transport offers except the quarantined ones.
   *
   * A vetted pool is a QUALITY preference — the members were measured, the rest
   * merely exist. A known-corrupting upstream is worse than an unmeasured one,
   * so when the last vetted member has to go, widening beats both keeping it
   * and emptying the pool. The sync restores the vetted pool as soon as
   * quarantines expire and re-probe clean.
   */
  poolWidened: boolean("pool_widened").default(false).notNull(),

  /**
   * Every upstream this model has, on every transport, is quarantined or gone.
   *
   * The breaker refuses to empty a pool, so the model keeps serving on its
   * least-bad endpoint — but it stops being anybody's first choice: a role
   * bound to it resolves to that role's FALLBACK model instead, and a team that
   * selected it degrades to the code default. Both paths already exist for
   * other reasons; this flag is what points them at a model in this state.
   */
  lastResort: boolean("last_resort").default(false).notNull(),

  /**
   * Smallest context any allowed endpoint offers, minus a safety margin. The
   * compaction threshold reads THIS, not the catalogue headline: endpoints for
   * one model span 262 144 to 1 048 576 tokens, and routing picks per request,
   * so budgeting against the largest silently overflows on the smallest.
   */
  effectiveContextLength: integer("effective_context_length").notNull(),
  effectiveMaxOutput: integer("effective_max_output"),

  /** Pool median, refreshed nightly. USD per 1,000,000 tokens. */
  pricing: jsonb("pricing").$type<PricingSnapshot>().notNull(),

  /** Derived from pricing; the future credit system bills off this number. */
  creditMultiplier: real("credit_multiplier"),

  health: varchar("health", { length: 16 })
    .$type<ModelHealth>()
    .default("unknown")
    .notNull(),
  /** 0-100 composite behind `health`, kept so the grade stays inspectable. */
  healthScore: real("health_score"),

  policyReport: jsonb("policy_report").$type<PolicyReport>(),

  /**
   * Consecutive syncs whose HARD rules failed. A single bad night is a vendor
   * hiccup; the streak is what an automatic disable is allowed to act on.
   */
  policyFailStreak: integer("policy_fail_streak").default(0).notNull(),

  /** Per-provider figures merged from every catalogue source. */
  endpointStats: jsonb("endpoint_stats").$type<EndpointStat[]>(),

  /**
   * When the model was released upstream.
   *
   * A stable identity fact rather than a measurement, and a column rather than
   * a jsonb field because the picker sorts and filters on it: "what is new"
   * is one of the two questions a team actually asks of a catalogue, and it
   * cannot be answered from an index or a price.
   *
   * From the gateway catalogue (`released`, Unix seconds — every one of its 239
   * language models carries it), falling back to Artificial Analysis for the
   * few models the catalogue does not list.
   */
  releasedAt: timestamp("released_at", { withTimezone: true }),

  aaMetrics: jsonb("aa_metrics").$type<AaMetrics>(),

  /**
   * Which Artificial Analysis record grades this model, written by the seed
   * from `assessment.aaSlug`. Curation owns it because only a human can settle
   * it: AA publishes ONE RECORD PER EFFORT LEVEL, so a model matched by name or
   * by id tail returns whichever rung happens to share our spelling rather than
   * the one we run (GPT-5.6 Luna spans 33.9 to 51.2 across its ladder). Without
   * it the sync grades a variant and the number looks entirely plausible.
   */
  aaSlug: varchar("aa_slug", { length: 96 }),

  /**
   * Catalogue-derived profile for models added by command rather than by pull
   * request, so a new model is selectable without a deploy. A hand-written
   * TypeScript profile wins over it when both exist.
   */
  dynamicProfile: jsonb("dynamic_profile").$type<DynamicProfile>(),

  /**
   * Internal roles bound to this model, written by the seed from
   * `ROLE_BINDINGS`. Non-empty means the fleet depends on it: the sync raises
   * an alert instead of disabling, because disabling would take the chatbot
   * down rather than degrade one team's choice.
   */
  boundRoles: text("bound_roles").array().default([]).notNull(),

  /** Last successful zero-retention probe — the only honest ZDR signal. */
  zdrProbeOk: boolean("zdr_probe_ok"),
  zdrProbeAt: timestamp("zdr_probe_at", { withTimezone: true }),

  source: varchar("source", { length: 16 })
    .$type<ModelStateSource>()
    .default("seed")
    .notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * One detector hit on one generation. The row is evidence for the breaker and
 * an audit trail for whoever reads an alert three weeks later.
 *
 * `evidence` holds CODEPOINTS AND COUNTS ONLY — never the text that carried
 * them. These streams are customer documents and conversations; a corruption
 * detector is not a licence to copy them into an infra table.
 */
export const modelProviderIncidents = pgTable(
  "model_provider_incidents",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    /** Profile key when known, else the raw model id (bypass call sites). */
    modelKey: varchar("model_key", { length: 128 }).notNull(),
    /** Normalised upstream name — the quarantine key. */
    provider: varchar("provider", { length: 128 }).notNull(),
    transport: varchar("transport", { length: 16 })
      .$type<TransportId>()
      .notNull(),
    kind: varchar("kind", { length: 32 }).$type<IncidentKind>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, number | string>>(),
    /** Upstream generation id, so a hit can be pulled up in the provider's logs. */
    generationId: varchar("generation_id", { length: 128 }),
    traceId: varchar("trace_id", { length: 128 }),
    role: varchar("role", { length: 48 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // The breaker's only query: recent hits of one kind on one (model, provider).
    index("model_incidents_lookup_idx").on(
      t.modelKey,
      t.provider,
      t.kind,
      t.createdAt,
    ),
  ],
);

/** One nightly sync. Kept so "when did this pool last change" has an answer. */
export const modelSyncRuns = pgTable("model_sync_runs", {
  id: uuid("id")
    .default(sql`uuid_generate_v7()`)
    .primaryKey(),
  status: varchar("status", { length: 16 })
    .$type<"running" | "ok" | "partial" | "failed">()
    .notNull(),
  stats: jsonb("stats").$type<Record<string, number | string[] | string>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/**
 * What the engine decided, in a form a person can read. The engine acts on its
 * own — that is the point — but "acted silently" and "acted invisibly" are
 * different things, and only the first one is acceptable.
 */
export const modelAlerts = pgTable(
  "model_alerts",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    kind: varchar("kind", { length: 32 })
      .$type<
        | "quarantine"
        | "quarantine-skipped"
        | "release"
        | "release-failed"
        | "model-disabled"
        | "policy-fail"
        | "new-candidate"
        | "catalog-removed"
        | "price-jump"
        | "critical-role-model"
        | "sync-failed"
        | "unknown-provider"
      >()
      .notNull(),
    severity: varchar("severity", { length: 16 })
      .$type<"info" | "warning" | "critical">()
      .default("warning")
      .notNull(),
    modelKey: varchar("model_key", { length: 128 }),
    provider: varchar("provider", { length: 128 }),
    message: text("message").notNull(),
    context: jsonb("context").$type<Record<string, unknown>>(),
    /**
     * When the alert was delivered outside the database. Written by the jobs
     * sweep, not by the raiser: the breaker runs inside a streaming turn, and
     * the email client throws at module load without its Scaleway credentials —
     * neither of which belongs on that path. The sweep also turns a burst of
     * related alerts into one digest instead of a storm.
     */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("model_alerts_recent_idx").on(t.createdAt, t.acknowledgedAt)],
);

/**
 * A `models:bench` measurement, so the numbers stop living in source comments
 * where nothing can compare them across dates. `intact` is the column that
 * decides pool membership: an upstream that truncates the answer whenever a
 * response ends in tool calls is unusable no matter how fast it is.
 */
export const modelBenchRuns = pgTable(
  "model_bench_runs",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    profileKey: varchar("profile_key", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 128 }).notNull(),
    transport: varchar("transport", { length: 16 })
      .$type<TransportId>()
      .notNull(),
    metrics: jsonb("metrics")
      .$type<{
        tokensPerSecondMedian?: number;
        tokensPerSecondBest?: number;
        intactPassed?: number;
        intactTotal?: number;
        coldCostUsd?: number;
        warmCostUsd?: number;
        reasoningTokens?: number;
        http429Count?: number;
        failures?: number;
        note?: string;
      }>()
      .notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("model_bench_lookup_idx").on(t.profileKey, t.ranAt)],
);

/**
 * Who did what to the registry, append-only.
 *
 * A `last_changed_by` column on `model_live_state` would answer only "who
 * touched it most recently", which is strictly weaker than a log and creates
 * an FK from a global infra table to `user`. And `source` cannot serve: it
 * says whether a write was automatic, not which person made it.
 *
 * Named `actions`, deliberately NOT `audit` — `models:admin audit` already
 * means "consistency checks", and one word for two things inside one feature
 * is a trap that outlives everyone who understood it.
 *
 * Written by the surface that has an actor, never by the services: the sync
 * and the breaker have nobody to name and must not start inventing one.
 * REFUSALS are recorded too — a retire refused on a role-bound model is
 * exactly the event someone goes looking for three weeks later.
 *
 * Global infra state: no org/team scoping, like the rest of this file.
 */
export const modelAdminActions = pgTable(
  "model_admin_actions",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    /** Nullable + SET NULL so the trail survives the operator's account. */
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    /** `promote`, `retire`, `quarantine`, … — the operation, not the outcome. */
    action: varchar("action", { length: 32 }).notNull(),
    profileKey: varchar("profile_key", { length: 64 }),
    /** The discriminant the operation returned, refusals included. */
    outcome: varchar("outcome", { length: 32 }).notNull(),
    /** Input, plus the before/after summaries and the consequences. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("model_admin_actions_recent_idx").on(t.createdAt),
    index("model_admin_actions_model_idx").on(t.profileKey, t.createdAt),
    index("model_admin_actions_user_idx").on(t.userId),
  ],
);

export type ModelLiveStateRow = typeof modelLiveState.$inferSelect;
export type NewModelLiveStateRow = typeof modelLiveState.$inferInsert;
export type ModelProviderIncidentRow =
  typeof modelProviderIncidents.$inferSelect;
export type ModelAlertRow = typeof modelAlerts.$inferSelect;
export type ModelAlertKind = ModelAlertRow["kind"];
export type ModelSyncRunRow = typeof modelSyncRuns.$inferSelect;
export type ModelBenchRunRow = typeof modelBenchRuns.$inferSelect;
export type ModelAdminActionRow = typeof modelAdminActions.$inferSelect;
