import db from "@fretik/shared/db";
import { modelAdminActions } from "@fretik/shared/db/schema";
import {
  authMiddleware,
  superAdminMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { notFound, throwHttpError } from "@fretik/shared/lib/errors";
import { selectOrCache } from "@fretik/shared/lib/redis";
import { modelKeyForId } from "@fretik/shared/model-registry/keys";
import { PROMOTION_PRICE_CAPS } from "@fretik/shared/model-registry/policy";
import {
  DEFAULT_QUARANTINE_KIND,
  DISABLED_REASONS,
  IMPLEMENTED_TRANSPORTS,
  INCIDENT_KINDS,
  isTransportId,
  MODEL_STATUSES,
  TRANSPORT_IDS,
  type Consequence,
  type EndpointStat,
  type LiveModelState,
  type ModelWriteActor,
  type PolicyReport,
  type ProviderPool,
  type QuarantineEntry,
  type QuarantineOutcome,
  type ReleaseOutcome,
} from "@fretik/shared/model-registry/types";
import {
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import { listRecentAlerts } from "@fretik/shared/services/model-registry/alerts";
import {
  activeQuarantines,
  effectivePoolFor,
} from "@fretik/shared/services/model-registry/breaker";
import { summarizeIncidents } from "@fretik/shared/services/model-registry/incidents";
import {
  getLiveRegistry,
  readAllLiveStateRows,
  readLiveStateRow,
} from "@fretik/shared/services/model-registry/live";
import {
  acknowledgeModelAlerts,
  addModelFromCatalogue,
  forecastEnablement,
  forecastPromotions,
  promoteModels,
  quarantineUpstream,
  releaseUpstream,
  retireModelOperation,
  setModelsEnabled,
  summarise,
  switchModelTransport,
} from "@fretik/shared/services/model-registry/operations";
import {
  evaluateScorecardPolicy,
  scorecardEndpoints,
  scorecardPool,
} from "@fretik/shared/services/model-registry/scorecard";
import { fetchGatewayCatalog } from "@fretik/shared/services/model-registry/sync/sources/gateway-catalog";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  getFamilyBranding,
  getModelDisplayName,
  normalizeFamily,
} from "../lib/model-registry/display";
import {
  auditCountsSchema,
  auditFindingSchema,
  runModelAudit,
} from "../services/model-audit/run";

/**
 * The model engine's operator surface, over HTTP.
 *
 * A second surface, not a replacement: `bun run models:admin` stays the escape
 * hatch when the front or this service is down, and the only form usable in CI.
 * What it adds is reach — taking a corrupting upstream out of a pool at three
 * in the morning currently needs a machine with `DATABASE_URL` and the
 * production environment, which half-cancels the property the whole engine
 * exists for: every write here takes effect on the next model construction,
 * fleet-wide, with no deploy.
 *
 * Super-admin only, and this is the first such route in `@fretik/ai`.
 * `superAdminMiddleware` is the ONLY wall, and behind it sits "disable the
 * whole fleet", so it is mounted on `*` rather than per route: a route added
 * later inherits the gate instead of being remembered.
 *
 * Every write goes through `@fretik/shared/services/model-registry/operations`,
 * never through a service directly: that is what keeps this surface and the
 * terminal agreeing on what a change MEANS, and what puts a line naming the
 * operator in the action log for each one — refusals included.
 *
 * Every timestamp on the wire is a real `Date`. The frontend's HTTP client
 * revives EVERY ISO-datetime-looking string in a response, including ones
 * nested in a jsonb column, so a schema saying `z.string()` for
 * `quarantinedAt` would be a type that lies to the component rendering it —
 * the exact defect that once killed a "most recent" sort in silence.
 */
const modelAdminRoutes = new OpenAPIHono<HonoLoggedAppType>();
modelAdminRoutes.use("*", authMiddleware);
modelAdminRoutes.use("*", superAdminMiddleware);

/** How much incident history a model's detail page reports, versus a scorecard. */
const DETAIL_INCIDENT_WINDOW_HOURS = 24;
const SCORECARD_INCIDENT_WINDOW_HOURS = 24 * 7;

/**
 * The scorecard's slow path is slow exactly when someone is waiting: a
 * candidate added a minute ago is precisely the row with no stored endpoint
 * stats, so it takes the live fetch. Eight seconds, against the sync's twenty
 * — a request that returns "the sync has not measured this row yet" beats one
 * that holds the connection for twenty seconds and then says the same thing.
 */
const SCORECARD_FETCH_TIMEOUT_MS = 8_000;

/**
 * The catalogue is a public document, identical for every operator, and it
 * moves on the order of days. Ten minutes in Redis turns a debounced search box
 * from one 20-second fetch PER KEYSTROKE into an instant filter.
 */
const CATALOGUE_CACHE_KEY = "model-admin:gateway-catalogue:v1";
const CATALOGUE_CACHE_TTL_S = 600;
const CATALOGUE_SEARCH_LIMIT = 25;

/** The audit reads one table and no network; a minute of sharing is plenty. */
const AUDIT_CACHE_KEY = "model-admin:audit:v1";
const AUDIT_CACHE_TTL_S = 60;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const pricingSchema = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number().optional(),
  cacheWritePerMTok: z.number().optional(),
});

const providerPoolSchema = z.object({
  only: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  sort: z.enum(["price", "throughput", "latency"]).optional(),
});

const brandingSchema = z.object({
  icon: z.string(),
  brandColor: z.string(),
  brandGradient: z.object({ from: z.string(), to: z.string() }).optional(),
});

const fleetRowSchema = z.object({
  profileKey: z.string(),
  displayName: z.string(),
  family: z.string(),
  branding: brandingSchema,
  status: z.enum(MODEL_STATUSES),
  /** The transport calls ACTUALLY go through — one row routes through one. */
  transport: z.enum(TRANSPORT_IDS),
  /**
   * Every transport this row carries an id for, `transport` included.
   *
   * The distinction is load-bearing: most models are served by several
   * transports and the row routes through ONE, so a column showing only the
   * active one reads as "this model is gateway-only" when the truth is "a
   * switch to openrouter is one call away". That switch is the engine's
   * rollback, so what it can switch TO belongs on the fleet view.
   */
  availableTransports: z.array(z.enum(TRANSPORT_IDS)),
  /**
   * What the model accepts, from the catalogue. `text` is always there; the
   * others appear only where a catalogue says so, and an EMPTY list means no
   * catalogue has described this row rather than a text-only model.
   */
  inputModalities: z.array(z.string()),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  health: z.enum(["healthy", "degraded", "failing", "unknown"]),
  healthScore: z.number().nullable(),
  effectiveContextLength: z.number(),
  effectiveMaxOutput: z.number().nullable(),
  pricing: pricingSchema,
  poolWidened: z.boolean(),
  lastResort: z.boolean(),
  /** What actually goes on the wire: the vetted list minus live quarantines. */
  wirePool: providerPoolSchema,
  activeQuarantineCount: z.number(),
  boundRoles: z.array(z.string()),
  /** False means the card shows a capitalised key and offers no thinking depth. */
  describedByCatalogue: z.boolean(),
  source: z.enum(["seed", "sync", "admin", "breaker"]),
  syncedAt: z.date().nullable(),
  releasedAt: z.date().nullable(),
});

const quarantineEntrySchema = z.object({
  provider: z.string(),
  transport: z.enum(TRANSPORT_IDS),
  kind: z.enum(INCIDENT_KINDS),
  quarantinedAt: z.date(),
  releaseAt: z.date(),
  incidentIds: z.array(z.string()),
  reason: z.string(),
});

const endpointStatSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  wireNames: z.record(z.string(), z.string()),
  contextLength: z.number(),
  maxCompletionTokens: z.number().optional(),
  pricing: pricingSchema,
  supportedParameters: z.array(z.string()),
  supportsImplicitCaching: z.boolean().optional(),
  /** Tri-state: absent means the source said nothing, NEVER that it said no. */
  hasZdr: z.boolean().optional(),
  quantization: z.string().optional(),
  supportsToolChoice: z.array(z.string()).optional(),
  uptime5m: z.number().optional(),
  uptime15m: z.number().optional(),
  uptime1h: z.number().optional(),
  uptime1d: z.number().optional(),
  throughputP50: z.number().optional(),
  throughputP95: z.number().optional(),
  latencyP50Ms: z.number().optional(),
  /** OpenRouter publishes p90 and no p95; kept apart so neither wears the other's name. */
  latencyP90Ms: z.number().optional(),
  latencyP95Ms: z.number().optional(),
  status: z.number().optional(),
  /**
   * When the measurement fields above were observed. Absent = never measured,
   * which a reader must be able to tell from a figure taken tonight — the UI
   * shows a kept figure's age rather than presenting it as current.
   */
  measuredAt: z.date().optional(),
});

const policyReportSchema = z.object({
  passed: z.boolean(),
  hardFailures: z.number(),
  softFailures: z.number(),
  /** Rules the policy sets that had no data to grade. Absent on reports predating 2026-09-01. */
  skippedRules: z.number().optional(),
  rules: z.array(
    z.object({
      rule: z.string(),
      passed: z.boolean(),
      severity: z.enum(["hard", "soft"]),
      detail: z.string(),
      /**
       * Present when the rule could not be evaluated, and `passed` is then
       * false without being a failure. `not-measured` is repairable (a
       * credential, an idle host); `not-published-by-source` is structural.
       * A client that renders `passed` alone would show every skip as a
       * failure — which is the opposite of the old bug and just as wrong.
       */
      skipped: z.enum(["not-measured", "not-published-by-source"]).optional(),
    }),
  ),
  evaluatedAt: z.date(),
  excludedProviders: z.array(
    z.object({ provider: z.string(), reason: z.string() }),
  ),
});

const aaMetricsSchema = z.object({
  slug: z.string().optional(),
  intelligenceIndex: z.number().optional(),
  codingIndex: z.number().optional(),
  agenticIndex: z.number().optional(),
  timeToFirstAnswerTokenSeconds: z.number().optional(),
  /** `YYYY-MM-DD`, deliberately a string: a date alone carries no timezone. */
  releaseDate: z.string().optional(),
  indexVersion: z.string().optional(),
  fetchedAt: z.date().optional(),
});

const incidentSummarySchema = z.array(
  z.object({
    provider: z.string(),
    kind: z.enum(INCIDENT_KINDS),
    total: z.number(),
  }),
);

const dynamicProfileSchema = z.object({
  displayName: z.string(),
  family: z.string(),
  contextLength: z.number(),
  maxCompletionTokens: z.number().optional(),
  inputModalities: z.array(z.string()),
  outputModalities: z.array(z.string()),
  supportsReasoning: z.boolean(),
  supportsTools: z.boolean(),
  reasoning: z
    .object({
      mandatory: z.boolean(),
      supportedEfforts: z.array(z.string()).optional(),
      defaultEffort: z.string().optional(),
      supportsMaxTokens: z.boolean().optional(),
    })
    .optional(),
  derivedFrom: z.object({ source: z.string(), at: z.date() }),
});

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const toWirePool = (
  pool: ProviderPool,
): z.infer<typeof providerPoolSchema> => ({
  ...(pool.only === undefined ? {} : { only: pool.only }),
  ...(pool.order === undefined ? {} : { order: pool.order }),
  ...(pool.ignore === undefined ? {} : { ignore: pool.ignore }),
  ...(pool.sort === undefined ? {} : { sort: pool.sort }),
});

const toWireQuarantine = (
  entry: QuarantineEntry,
): z.infer<typeof quarantineEntrySchema> => ({
  provider: entry.provider,
  transport: entry.transport,
  kind: entry.kind,
  quarantinedAt: new Date(entry.quarantinedAt),
  releaseAt: new Date(entry.releaseAt),
  incidentIds: entry.incidentIds,
  reason: entry.reason,
});

const toWireReport = (
  report: PolicyReport,
): z.infer<typeof policyReportSchema> => ({
  passed: report.passed,
  hardFailures: report.hardFailures,
  softFailures: report.softFailures,
  rules: report.rules,
  evaluatedAt: new Date(report.evaluatedAt),
  excludedProviders: report.excludedProviders,
});

const toWireEndpoint = (
  stat: EndpointStat,
): z.infer<typeof endpointStatSchema> => {
  // `wireNames` is a partial record, so its values are `string | undefined`
  // while the wire shape is a plain string map. Rebuilt rather than cast: an
  // absent wire name is a real state (the source never spelled this host), and
  // it must reach the client as an ABSENT key, not as `null`.
  const wireNames: Record<string, string> = {};
  for (const [transport, id] of Object.entries(stat.wireNames)) {
    if (id !== undefined) wireNames[transport] = id;
  }
  // `measuredAt` is an ISO string in the jsonb and a real `Date` on the wire,
  // like `aaMetrics.fetchedAt` above. The client rehydrates every ISO string
  // into a `Date` anyway, so a schema saying `string` would be a type that
  // lies — the defect that once killed a sort silently.
  const { measuredAt, ...rest } = stat;
  return {
    ...rest,
    wireNames,
    ...(measuredAt === undefined ? {} : { measuredAt: new Date(measuredAt) }),
  };
};

const toWireAa = (
  state: LiveModelState,
): z.infer<typeof aaMetricsSchema> | null => {
  const aa = state.aaMetrics;
  if (aa === null) return null;
  const { fetchedAt, ...rest } = aa;
  return {
    ...rest,
    ...(fetchedAt === undefined ? {} : { fetchedAt: new Date(fetchedAt) }),
  };
};

const toWireDynamicProfile = (
  state: LiveModelState,
): z.infer<typeof dynamicProfileSchema> | null => {
  const dynamic = state.dynamicProfile;
  if (dynamic === null) return null;
  return {
    displayName: dynamic.displayName,
    family: dynamic.family,
    contextLength: dynamic.contextLength,
    ...(dynamic.maxCompletionTokens === undefined
      ? {}
      : { maxCompletionTokens: dynamic.maxCompletionTokens }),
    inputModalities: dynamic.inputModalities,
    outputModalities: dynamic.outputModalities,
    supportsReasoning: dynamic.supportsReasoning,
    supportsTools: dynamic.supportsTools,
    ...(dynamic.reasoning === undefined
      ? {}
      : { reasoning: dynamic.reasoning }),
    derivedFrom: {
      source: dynamic.derivedFrom.source,
      at: new Date(dynamic.derivedFrom.at),
    },
  };
};

const toFleetRow = (
  state: LiveModelState,
  now: Date,
): z.infer<typeof fleetRowSchema> => {
  const family = normalizeFamily(state.dynamicProfile?.family ?? "other");
  return {
    profileKey: state.profileKey,
    displayName: getModelDisplayName(state.profileKey),
    family,
    branding: getFamilyBranding(family),
    status: state.status,
    transport: state.transport,
    availableTransports: Object.keys(state.modelIds).filter(isTransportId),
    inputModalities: state.dynamicProfile?.inputModalities ?? [],
    enabled: state.enabled,
    disabledReason: state.disabledReason,
    health: state.health,
    healthScore: state.healthScore,
    effectiveContextLength: state.effectiveContextLength,
    effectiveMaxOutput: state.effectiveMaxOutput,
    pricing: state.pricing,
    poolWidened: state.poolWidened,
    lastResort: state.lastResort,
    wirePool: toWirePool(effectivePoolFor(state, state.transport, now)),
    activeQuarantineCount: activeQuarantines(state, now).length,
    boundRoles: state.boundRoles,
    describedByCatalogue: state.dynamicProfile !== null,
    source: state.source,
    syncedAt: state.syncedAt,
    releasedAt: state.releasedAt,
  };
};

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

const listModelsRoute = createRoute({
  method: "get",
  path: "/models",
  summary: "The whole model fleet, as the engine sees it (super-admin)",
  tags: ["Model admin"],
  request: {
    query: z.object({ status: z.enum(MODEL_STATUSES).optional() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            models: z.array(fleetRowSchema),
            counts: z.object({
              total: z.number(),
              published: z.number(),
              candidate: z.number(),
              retired: z.number(),
              disabled: z.number(),
              lastResort: z.number(),
              quarantined: z.number(),
            }),
          }),
        },
      },
      description: "Every live row, with its real wire pool",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(listModelsRoute, async (c) => {
  const { status } = c.req.valid("query");
  const now = new Date();
  // The rows come from the database rather than the cached snapshot: this is
  // the surface where a candidate another operator added ten seconds ago has
  // to be visible. The snapshot is warmed alongside it because the display
  // name and the family are read from it.
  const [rows] = await Promise.all([readAllLiveStateRows(), getLiveRegistry()]);
  const counts = {
    total: rows.length,
    published: rows.filter((row) => row.status === "published").length,
    candidate: rows.filter((row) => row.status === "candidate").length,
    retired: rows.filter((row) => row.status === "retired").length,
    disabled: rows.filter((row) => !row.enabled).length,
    lastResort: rows.filter((row) => row.lastResort).length,
    quarantined: rows.filter((row) => activeQuarantines(row, now).length > 0)
      .length,
  };
  const models = rows
    .filter((row) => status === undefined || row.status === status)
    .sort(
      (a, b) =>
        a.status.localeCompare(b.status) ||
        a.profileKey.localeCompare(b.profileKey),
    )
    .map((row) => toFleetRow(row, now));
  return c.json({ models, counts }, 200);
});

const showModelRoute = createRoute({
  method: "get",
  path: "/models/{profileKey}",
  summary: "One model: routing, policy, endpoints, quarantines (super-admin)",
  tags: ["Model admin"],
  request: { params: z.object({ profileKey: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: fleetRowSchema.extend({
            modelIds: z.record(z.string(), z.string()),
            creditMultiplier: z.number().nullable(),
            /** What curation vetted, against what the breaker leaves of it. */
            declaredPool: providerPoolSchema,
            quarantines: z.array(quarantineEntrySchema),
            policyReport: policyReportSchema.nullable(),
            endpoints: z.array(endpointStatSchema),
            aaMetrics: aaMetricsSchema.nullable(),
            dynamicProfile: dynamicProfileSchema.nullable(),
            incidents: incidentSummarySchema,
            incidentWindowHours: z.number(),
          }),
        },
      },
      description: "The model's live state in full",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(showModelRoute, async (c) => {
  const { profileKey } = c.req.valid("param");
  const now = new Date();
  await getLiveRegistry();
  const state = await readLiveStateRow(profileKey);
  if (state === undefined) {
    return throwHttpError(404, notFound(`No model row for "${profileKey}".`));
  }
  return c.json(
    {
      ...toFleetRow(state, now),
      modelIds: state.modelIds,
      creditMultiplier: state.creditMultiplier,
      declaredPool: toWirePool(state.providerPool[state.transport] ?? {}),
      quarantines: activeQuarantines(state, now).map(toWireQuarantine),
      policyReport:
        state.policyReport === null ? null : toWireReport(state.policyReport),
      endpoints: state.endpointStats.map(toWireEndpoint),
      aaMetrics: toWireAa(state),
      dynamicProfile: toWireDynamicProfile(state),
      incidents: await summarizeIncidents({
        modelKey: profileKey,
        windowHours: DETAIL_INCIDENT_WINDOW_HOURS,
        now,
      }),
      incidentWindowHours: DETAIL_INCIDENT_WINDOW_HOURS,
    },
    200,
  );
});

const scorecardRoute = createRoute({
  method: "get",
  path: "/models/{profileKey}/scorecard",
  summary: "The promotion aid for one model (super-admin)",
  tags: ["Model admin"],
  request: { params: z.object({ profileKey: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            profileKey: z.string(),
            /**
             * Where the endpoints came from. On either failure the verdict
             * below was computed from nothing and must be shown as such —
             * never as a model that failed every rule.
             */
            endpointSource: z.enum([
              "stored",
              "live",
              "no-gateway-id",
              "fetch-failed",
            ]),
            endpointError: z.string().optional(),
            syncedAt: z.date().nullable(),
            endpoints: z.array(endpointStatSchema),
            excluded: z.array(
              z.object({ provider: z.string(), reason: z.string() }),
            ),
            aaMetrics: aaMetricsSchema.nullable(),
            policyReport: policyReportSchema,
            incidents: incidentSummarySchema,
            incidentWindowHours: z.number(),
          }),
        },
      },
      description: "Endpoints, grades and the discovery-policy verdict",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(scorecardRoute, async (c) => {
  const { profileKey } = c.req.valid("param");
  const now = new Date();
  const state = await readLiveStateRow(profileKey);
  if (state === undefined) {
    return throwHttpError(404, notFound(`No model row for "${profileKey}".`));
  }
  // Never a 500 on the endpoint fetch: `scorecardEndpoints` reports its own
  // failure as a source, and a page that says "the sync has not measured this
  // row yet" is honest where an error page would be misread as a broken model.
  const { endpoints, source, error } = await scorecardEndpoints(state, {
    timeoutMs: SCORECARD_FETCH_TIMEOUT_MS,
  });
  const pool = scorecardPool(state, endpoints, now);
  return c.json(
    {
      profileKey,
      endpointSource: source,
      ...(error === undefined ? {} : { endpointError: error }),
      syncedAt: state.syncedAt,
      endpoints: pool.endpoints.map(toWireEndpoint),
      excluded: pool.excluded,
      aaMetrics: toWireAa(state),
      policyReport: toWireReport(
        evaluateScorecardPolicy({
          endpoints: pool.endpoints,
          excluded: pool.excluded,
          aa: state.aaMetrics,
          now,
        }),
      ),
      incidents: await summarizeIncidents({
        modelKey: profileKey,
        windowHours: SCORECARD_INCIDENT_WINDOW_HOURS,
        now,
      }),
      incidentWindowHours: SCORECARD_INCIDENT_WINDOW_HOURS,
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const listAlertsRoute = createRoute({
  method: "get",
  path: "/alerts",
  summary: "What the engine decided on its own (super-admin)",
  tags: ["Model admin"],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(30),
      /** The filter the CLI lacks, and the first thing a screen wants. */
      unacknowledgedOnly: z.stringbool().default(false),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            alerts: z.array(
              z.object({
                id: z.string(),
                kind: z.string(),
                severity: z.enum(["info", "warning", "critical"]),
                modelKey: z.string().nullable(),
                provider: z.string().nullable(),
                message: z.string(),
                createdAt: z.date(),
                acknowledgedAt: z.date().nullable(),
                notifiedAt: z.date().nullable(),
              }),
            ),
            unacknowledged: z.number(),
          }),
        },
      },
      description: "Recent alerts, newest first",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(listAlertsRoute, async (c) => {
  const { limit, unacknowledgedOnly } = c.req.valid("query");
  const rows = await listRecentAlerts(limit);
  const alerts = rows
    .filter((row) => !unacknowledgedOnly || row.acknowledgedAt === null)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      modelKey: row.modelKey,
      provider: row.provider,
      message: row.message,
      createdAt: row.createdAt,
      acknowledgedAt: row.acknowledgedAt,
      notifiedAt: row.notifiedAt,
    }));
  return c.json(
    {
      alerts,
      unacknowledged: rows.filter((row) => row.acknowledgedAt === null).length,
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const auditRoute = createRoute({
  method: "get",
  path: "/audit",
  summary: "Everything the engine can contradict itself about (super-admin)",
  tags: ["Model admin"],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            findings: z.array(auditFindingSchema),
            counts: auditCountsSchema,
            snapshotAt: z.date(),
          }),
        },
      },
      description:
        "The audit's findings. An audit that finds problems is a SUCCESSFUL audit — this never answers 500 for a finding.",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(auditRoute, async (c) => {
  // `snapshotAt` rides in the cache as an ISO string rather than a `Date`,
  // because the cache round-trips through JSON: typing it `Date` here would be
  // a type that is right on a miss and wrong on a hit.
  const cached = await selectOrCache(
    async () => {
      const report = await runModelAudit();
      return { ...report, snapshotAt: report.snapshotAt.toISOString() };
    },
    AUDIT_CACHE_KEY,
    AUDIT_CACHE_TTL_S,
  );
  return c.json({ ...cached, snapshotAt: new Date(cached.snapshotAt) }, 200);
});

// ---------------------------------------------------------------------------
// Catalogue search
// ---------------------------------------------------------------------------

/**
 * The catalogue projection that survives a JSON round-trip through Redis.
 *
 * `releasedAt` is an ISO string here on purpose: `selectOrCache` parses what it
 * stored, so a cached `Date` comes back as a string while a freshly computed
 * one is a `Date` — the same value with two types depending on cache weather.
 */
interface CachedCatalogueEntry {
  id: string;
  name: string;
  owner: string;
  contextWindow?: number;
  isLanguageModel?: boolean;
  deprecated?: boolean;
  releasedAt?: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
}

const catalogueSearchRoute = createRoute({
  method: "get",
  path: "/catalogue/search",
  summary: "Search the gateway catalogue for a model to add (super-admin)",
  tags: ["Model admin"],
  request: { query: z.object({ q: z.string().min(1).max(120) }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            catalogueSize: z.number(),
            results: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                owner: z.string(),
                contextWindow: z.number().optional(),
                isLanguageModel: z.boolean().optional(),
                deprecated: z.boolean().optional(),
                releasedAt: z.date().optional(),
                inputPerMTok: z.number().optional(),
                outputPerMTok: z.number().optional(),
                /** The key `add` would derive — and whether a row already holds it. */
                profileKey: z.string(),
                alreadyKnown: z.boolean(),
              }),
            ),
          }),
        },
      },
      description: "Catalogue matches, newest-priced first",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(catalogueSearchRoute, async (c) => {
  const { q } = c.req.valid("query");
  const entries = await selectOrCache<CachedCatalogueEntry[]>(
    async () =>
      (await fetchGatewayCatalog()).map((entry) => ({
        id: entry.id,
        name: entry.name,
        owner: entry.owner,
        ...(entry.contextWindow === undefined
          ? {}
          : { contextWindow: entry.contextWindow }),
        ...(entry.isLanguageModel === undefined
          ? {}
          : { isLanguageModel: entry.isLanguageModel }),
        ...(entry.deprecated === undefined
          ? {}
          : { deprecated: entry.deprecated }),
        ...(entry.releasedAt === undefined
          ? {}
          : { releasedAt: entry.releasedAt.toISOString() }),
        ...(entry.pricing.inputPerMTok === undefined
          ? {}
          : { inputPerMTok: entry.pricing.inputPerMTok }),
        ...(entry.pricing.outputPerMTok === undefined
          ? {}
          : { outputPerMTok: entry.pricing.outputPerMTok }),
      })),
    CATALOGUE_CACHE_KEY,
    CATALOGUE_CACHE_TTL_S,
  );

  const known = new Set(
    (await readAllLiveStateRows()).map((r) => r.profileKey),
  );
  const needle = q.toLowerCase();
  const results = entries
    .filter(
      (entry) =>
        entry.id.toLowerCase().includes(needle) ||
        entry.name.toLowerCase().includes(needle),
    )
    // A prefix match is what someone typing a maker's name means; substring
    // matches follow, alphabetically, so the list does not reshuffle per key.
    .sort((a, b) => {
      const aPrefix = a.id.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.id.toLowerCase().startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || a.id.localeCompare(b.id);
    })
    .slice(0, CATALOGUE_SEARCH_LIMIT)
    .map((entry) => {
      const profileKey = modelKeyForId(entry.id);
      return {
        ...entry,
        ...(entry.releasedAt === undefined
          ? {}
          : { releasedAt: new Date(entry.releasedAt) }),
        profileKey,
        alreadyKnown: known.has(profileKey),
      };
    });
  return c.json({ catalogueSize: entries.length, results }, 200);
});

// ---------------------------------------------------------------------------
// Action log
// ---------------------------------------------------------------------------

const listActionsRoute = createRoute({
  method: "get",
  path: "/actions",
  summary: "Who did what to the registry (super-admin)",
  tags: ["Model admin"],
  request: {
    query: z.object({
      profileKey: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(
            z.object({
              id: z.string(),
              userId: z.string().nullable(),
              action: z.string(),
              profileKey: z.string().nullable(),
              /** The discriminant the operation returned, refusals included. */
              outcome: z.string(),
              createdAt: z.date(),
            }),
          ),
        },
      },
      description: "The action log, newest first",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(listActionsRoute, async (c) => {
  const { profileKey, limit } = c.req.valid("query");
  // `payload` is deliberately not on the wire: it holds the before/after
  // summaries and the consequences of every write ever made, which is a large
  // response for a list nobody reads that way. The detail belongs to a future
  // per-action route, if one is ever needed.
  const rows = await db
    .select({
      id: modelAdminActions.id,
      userId: modelAdminActions.userId,
      action: modelAdminActions.action,
      profileKey: modelAdminActions.profileKey,
      outcome: modelAdminActions.outcome,
      createdAt: modelAdminActions.createdAt,
    })
    .from(modelAdminActions)
    .where(
      profileKey === undefined
        ? undefined
        : eq(modelAdminActions.profileKey, profileKey),
    )
    .orderBy(desc(modelAdminActions.createdAt))
    .limit(limit);
  return c.json(rows, 200);
});

// ---------------------------------------------------------------------------
// Writes — shared envelope
// ---------------------------------------------------------------------------

/**
 * One rule decides every status code below, and it is worth stating once.
 *
 * A PRE-CONDITION failure — "you are asking for something that cannot happen" —
 * is a 409, and nothing was written. A surprise AFTER the fact is a 200 with
 * the surprise in `consequences`. Under that rule `not-quarantined` is a 409
 * and `last-resort` is a 200: the quarantine did land, and the model stepping
 * down to a fallback is the consequence of it, not a refusal of it.
 *
 * The BODY is identical either way — `{ outcome, before, after, consequences }`
 * — because the outcome is the decision and the status is only how a generic
 * client learns whether anything changed. A refusal a page has to render (which
 * upstreams are still quarantined elsewhere, which roles blocked a retire)
 * arrives structured, not as prose to re-parse.
 */
const modelStateSummarySchema = z.object({
  profileKey: z.string(),
  status: z.enum(MODEL_STATUSES),
  transport: z.enum(TRANSPORT_IDS),
  enabled: z.boolean(),
  disabledReason: z.enum(DISABLED_REASONS).nullable(),
  health: z.enum(["healthy", "degraded", "failing", "unknown"]),
  poolWidened: z.boolean(),
  lastResort: z.boolean(),
  activeQuarantineCount: z.number(),
  boundRoles: z.array(z.string()),
});

const consequenceSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("published-disabled-on-cost"),
    inputPerMTok: z.number(),
    outputPerMTok: z.number(),
    capInputPerMTok: z.number(),
    capOutputPerMTok: z.number(),
  }),
  z.object({ code: z.literal("catalogue-derived-profile-only") }),
  z.object({ code: z.literal("was-already-enabled") }),
  z.object({
    code: z.literal("still-unpublished"),
    status: z.enum(MODEL_STATUSES),
  }),
  z.object({
    code: z.literal("roles-bypass-enabled"),
    roles: z.array(z.string()),
  }),
  z.object({
    code: z.literal("quarantines-kept-per-transport"),
    kept: z.number(),
  }),
  z.object({ code: z.literal("pool-widened"), remaining: z.number() }),
  z.object({
    code: z.literal("transport-switched"),
    from: z.enum(TRANSPORT_IDS),
    to: z.enum(TRANSPORT_IDS),
  }),
  z.object({ code: z.literal("now-last-resort") }),
  z.object({
    code: z.literal("breaker-would-need"),
    kind: z.enum(INCIDENT_KINDS),
    generations: z.number(),
    windowMinutes: z.number(),
  }),
  z.object({
    code: z.literal("release-is-review-trigger"),
    releaseAt: z.date(),
  }),
  z.object({ code: z.literal("pool-renarrowed") }),
  z.object({ code: z.literal("last-resort-lifted") }),
]);

/** The two consequences whose payload the wire shape does not take verbatim. */
const toWireConsequence = (
  consequence: Consequence,
): z.infer<typeof consequenceSchema> => {
  if (consequence.code === "release-is-review-trigger") {
    return {
      code: consequence.code,
      releaseAt: new Date(consequence.releaseAt),
    };
  }
  if (consequence.code === "roles-bypass-enabled") {
    return { code: consequence.code, roles: [...consequence.roles] };
  }
  return consequence;
};

const writeEnvelope = <T extends z.ZodType>(outcome: T) =>
  z.object({
    outcome,
    before: modelStateSummarySchema.optional(),
    after: modelStateSummarySchema.optional(),
    consequences: z.array(consequenceSchema),
  });

const writeResponses = <T extends z.ZodType>(
  outcome: T,
  description: string,
) => ({
  200: {
    content: { "application/json": { schema: writeEnvelope(outcome) } },
    description,
  },
  409: {
    content: { "application/json": { schema: writeEnvelope(outcome) } },
    description:
      "Refused — nothing was written. The refusal is in `outcome`, structured.",
  },
  ...responseForbiddenSchema,
  ...responseNotFoundSchema,
  ...responseInternalErrorSchema,
});

const profileKeyParam = z.object({ profileKey: z.string() });

/** A `TransportId` the build can actually serve. `custom` is declared, not implemented. */
const servedTransportSchema = z
  .enum(TRANSPORT_IDS)
  .refine((transport) => IMPLEMENTED_TRANSPORTS.includes(transport), {
    message: `Transport has no adapter — implemented: ${IMPLEMENTED_TRANSPORTS.join(", ")}`,
  });

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

const addOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("not-in-catalogue"),
    catalogueSize: z.number(),
    /** A did-you-mean list, for suggestion chips rather than a text blob. */
    near: z.array(z.string()),
  }),
  z.object({ kind: z.literal("not-a-language-model") }),
  z.object({
    kind: z.literal("key-exists"),
    profileKey: z.string(),
    status: z.enum(MODEL_STATUSES),
    modelIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("no-eligible-endpoint"),
    endpointCount: z.number(),
    excluded: z.array(z.object({ provider: z.string(), reason: z.string() })),
  }),
  z.object({ kind: z.literal("insert-lost-race"), profileKey: z.string() }),
  z.object({
    kind: z.literal("added"),
    profileKey: z.string(),
    model: fleetRowSchema,
    endpoints: z.array(endpointStatSchema),
    excluded: z.array(z.object({ provider: z.string(), reason: z.string() })),
    /** The discovery-policy verdict, so the page can show a scorecard at once. */
    policyReport: policyReportSchema,
  }),
]);

const addModelRoute = createRoute({
  method: "post",
  path: "/models",
  summary: "Add a catalogue model as a CANDIDATE (super-admin)",
  tags: ["Model admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            modelId: z.string().min(1).max(200),
            profileKey: z.string().min(1).max(64).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: writeResponses(
    addOutcomeSchema,
    "Added as a candidate — invisible to teams until it is promoted",
  ),
});

modelAdminRoutes.openapi(addModelRoute, async (c) => {
  const { modelId, profileKey } = c.req.valid("json");
  const now = new Date();
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const outcome = await addModelFromCatalogue({
    modelId,
    ...(profileKey === undefined ? {} : { profileKey }),
    actor,
    now,
  });
  if (outcome.kind !== "added") {
    return c.json({ outcome, consequences: [] }, 409);
  }
  await getLiveRegistry();
  return c.json(
    {
      outcome: {
        kind: outcome.kind,
        profileKey: outcome.profileKey,
        model: toFleetRow(outcome.state, now),
        endpoints: outcome.endpoints.map(toWireEndpoint),
        excluded: outcome.excluded,
        policyReport: toWireReport(
          evaluateScorecardPolicy({
            endpoints: outcome.endpoints,
            excluded: outcome.excluded,
            aa: outcome.state.aaMetrics,
            now,
          }),
        ),
      },
      after: summarise(outcome.state, now),
      consequences: [],
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// Bulk promote
// ---------------------------------------------------------------------------

/** The cap is on the REQUEST, not the loop: 25 keys is one screenful of intent. */
const MAX_BULK_KEYS = 25;

const bulkKeysSchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(MAX_BULK_KEYS);

const bulkFailureSchema = z.object({
  kind: z.literal("failed"),
  message: z.string(),
});

const promoteOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown-model") }),
  z.object({
    kind: z.literal("already-published"),
    enabled: z.boolean(),
    disabledReason: z.literal("cost").nullable(),
  }),
  z.object({
    kind: z.literal("promoted"),
    enabled: z.boolean(),
    disabledReason: z.literal("cost").nullable(),
    pricing: pricingSchema,
    catalogueDerivedOnly: z.boolean(),
  }),
  bulkFailureSchema,
]);

const promoteRoute = createRoute({
  method: "post",
  path: "/models/promote",
  summary: "Publish one or more candidates (super-admin)",
  tags: ["Model admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ profileKeys: bulkKeysSchema }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(
              z.object({
                profileKey: z.string(),
                outcome: promoteOutcomeSchema,
                consequences: z.array(consequenceSchema),
              }),
            ),
          }),
        },
      },
      description:
        "One verdict per key. ALWAYS 200: the batch is not transactional, so a mistyped key must not discard the decisions that landed.",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(promoteRoute, async (c) => {
  const { profileKeys } = c.req.valid("json");
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const entries = await promoteModels({ profileKeys, actor });
  return c.json(
    {
      entries: entries.map((entry) => ({
        profileKey: entry.profileKey,
        outcome: entry.outcome,
        consequences: entry.consequences.map(toWireConsequence),
      })),
    },
    200,
  );
});

const promotePreflightRoute = createRoute({
  method: "post",
  path: "/models/promote/preflight",
  summary: "What promoting these keys WOULD do (super-admin)",
  tags: ["Model admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ profileKeys: bulkKeysSchema }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            forecasts: z.array(
              z.object({
                profileKey: z.string(),
                currentStatus: z.enum([...MODEL_STATUSES, "unknown"]),
                willEnable: z.boolean(),
                pricing: z
                  .object({
                    inputPerMTok: z.number(),
                    outputPerMTok: z.number(),
                  })
                  .optional(),
                catalogueDerivedOnly: z.boolean(),
                boundRoles: z.array(z.string()),
              }),
            ),
            /**
             * The caps the verdict was computed against. On the wire because a
             * client cannot derive them, and showing "price vs cap" per row is
             * the whole point of the screen.
             */
            caps: z.object({
              inputPerMTok: z.number(),
              outputPerMTok: z.number(),
            }),
          }),
        },
      },
      description: "Nothing is written",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(promotePreflightRoute, async (c) =>
  c.json(
    {
      forecasts: await forecastPromotions(c.req.valid("json").profileKeys),
      caps: {
        inputPerMTok: PROMOTION_PRICE_CAPS.inputPerMTok,
        outputPerMTok: PROMOTION_PRICE_CAPS.outputPerMTok,
      },
    },
    200,
  ),
);

// ---------------------------------------------------------------------------
// Bulk enable / disable
// ---------------------------------------------------------------------------

const setEnabledOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown-model") }),
  z.object({
    kind: z.literal("updated"),
    enabled: z.boolean(),
    disabledReason: z.enum(DISABLED_REASONS).nullable(),
    boundRoles: z.array(z.string()),
  }),
  bulkFailureSchema,
]);

const setEnabledRoute = createRoute({
  method: "post",
  path: "/models/enabled",
  summary: "Make one or more models selectable, or not (super-admin)",
  tags: ["Model admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            profileKeys: bulkKeysSchema,
            enabled: z.boolean(),
            reason: z.enum(DISABLED_REASONS).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(
              z.object({
                profileKey: z.string(),
                outcome: setEnabledOutcomeSchema,
                consequences: z.array(consequenceSchema),
              }),
            ),
          }),
        },
      },
      description: "One verdict per key. Always 200 — see `/models/promote`.",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(setEnabledRoute, async (c) => {
  const { profileKeys, enabled, reason } = c.req.valid("json");
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const entries = await setModelsEnabled({
    profileKeys,
    enabled,
    ...(reason === undefined ? {} : { reason }),
    actor,
  });
  return c.json(
    {
      entries: entries.map((entry) => ({
        profileKey: entry.profileKey,
        outcome: entry.outcome,
        consequences: entry.consequences.map(toWireConsequence),
      })),
    },
    200,
  );
});

const setEnabledPreflightRoute = createRoute({
  method: "post",
  path: "/models/enabled/preflight",
  summary: "What enabling or disabling these keys WOULD do (super-admin)",
  tags: ["Model admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            profileKeys: bulkKeysSchema,
            enabled: z.boolean(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            forecasts: z.array(
              z.object({
                profileKey: z.string(),
                exists: z.boolean(),
                currentStatus: z.enum([...MODEL_STATUSES, "unknown"]),
                currentlyEnabled: z.boolean(),
                noOp: z.boolean(),
                /**
                 * The warning that matters when disabling: these roles keep
                 * running, because a bound role resolves its model directly
                 * and never consults `enabled`.
                 */
                boundRoles: z.array(z.string()),
              }),
            ),
          }),
        },
      },
      description: "Nothing is written",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(setEnabledPreflightRoute, async (c) => {
  const { profileKeys, enabled } = c.req.valid("json");
  return c.json(
    { forecasts: await forecastEnablement(profileKeys, enabled) },
    200,
  );
});

// ---------------------------------------------------------------------------
// Single-model writes
// ---------------------------------------------------------------------------

const retireOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown-model") }),
  z.object({
    kind: z.literal("refused-bound-roles"),
    roles: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("retired"),
    previousStatus: z.enum(MODEL_STATUSES),
  }),
]);

const retireRoute = createRoute({
  method: "post",
  path: "/models/{profileKey}/retire",
  summary: "Take a model out of every picker, history kept (super-admin)",
  tags: ["Model admin"],
  request: { params: profileKeyParam },
  responses: writeResponses(
    retireOutcomeSchema,
    "Retired. REFUSES on a model an internal role runs on — that is the chatbot losing its model, not a team losing a preference.",
  ),
});

modelAdminRoutes.openapi(retireRoute, async (c) => {
  const { profileKey } = c.req.valid("param");
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const result = await retireModelOperation({ profileKey, actor });
  if (result.outcome.kind === "unknown-model") {
    return throwHttpError(404, notFound(`No model row for "${profileKey}".`));
  }
  const body = { ...result, consequences: [] };
  if (result.outcome.kind === "refused-bound-roles") {
    return c.json(body, 409);
  }
  return c.json(body, 200);
});

const setTransportOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown-model") }),
  z.object({
    kind: z.literal("no-model-id"),
    transport: z.enum(TRANSPORT_IDS),
    available: z.array(z.enum(TRANSPORT_IDS)),
  }),
  z.object({
    kind: z.literal("already-on-transport"),
    transport: z.enum(TRANSPORT_IDS),
  }),
  z.object({
    kind: z.literal("switched"),
    from: z.enum(TRANSPORT_IDS),
    to: z.enum(TRANSPORT_IDS),
  }),
]);

const setTransportRoute = createRoute({
  method: "post",
  path: "/models/{profileKey}/transport",
  summary: "Move a model to another transport (super-admin)",
  tags: ["Model admin"],
  request: {
    params: profileKeyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ transport: servedTransportSchema }),
        },
      },
      required: true,
    },
  },
  responses: writeResponses(
    setTransportOutcomeSchema,
    "Switched. THE rollback — one call takes a model off one transport and onto another, with its pool for that transport already on the row.",
  ),
});

modelAdminRoutes.openapi(setTransportRoute, async (c) => {
  const { profileKey } = c.req.valid("param");
  const { transport } = c.req.valid("json");
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const result = await switchModelTransport({ profileKey, transport, actor });
  if (result.outcome.kind === "unknown-model") {
    return throwHttpError(404, notFound(`No model row for "${profileKey}".`));
  }
  const body = {
    ...result,
    consequences: result.consequences.map(toWireConsequence),
  };
  if (result.outcome.kind === "switched") return c.json(body, 200);
  return c.json(body, 409);
});

const quarantineOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-live-row") }),
  z.object({
    kind: z.literal("already-quarantined"),
    entry: quarantineEntrySchema,
  }),
  z.object({
    kind: z.literal("quarantined"),
    entry: quarantineEntrySchema,
    remaining: z.number(),
    remainingSource: z.enum(["vetted", "endpoints"]),
  }),
  z.object({
    kind: z.literal("pool-widened"),
    entry: quarantineEntrySchema,
    remaining: z.number(),
  }),
  z.object({
    kind: z.literal("transport-switched"),
    entry: quarantineEntrySchema,
    from: z.enum(TRANSPORT_IDS),
    to: z.enum(TRANSPORT_IDS),
  }),
  z.object({ kind: z.literal("last-resort") }),
]);

/** The rungs carry a `QuarantineEntry`, whose two ISO strings owe the wire `Date`s. */
const toWireQuarantineOutcome = (
  outcome: QuarantineOutcome,
): z.infer<typeof quarantineOutcomeSchema> =>
  outcome.kind === "no-live-row" || outcome.kind === "last-resort"
    ? outcome
    : { ...outcome, entry: toWireQuarantine(outcome.entry) };

const quarantineRoute = createRoute({
  method: "post",
  path: "/models/{profileKey}/quarantine",
  summary: "Take an upstream out of a model's pool (super-admin)",
  tags: ["Model admin"],
  request: {
    params: profileKeyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1).max(64),
            /** Defaults to the model's current transport — quarantine is per transport. */
            transport: servedTransportSchema.optional(),
            kind: z.enum(INCIDENT_KINDS).optional(),
            reason: z.string().min(1).max(500).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: writeResponses(
    quarantineOutcomeSchema,
    "The rung the escalation ladder reached. `last-resort` is a 200: the host keeps serving and the MODEL steps down, which is a consequence of the write, not a refusal of it.",
  ),
});

modelAdminRoutes.openapi(quarantineRoute, async (c) => {
  const { profileKey } = c.req.valid("param");
  const body = c.req.valid("json");
  const now = new Date();
  const state = await readLiveStateRow(profileKey);
  if (state === undefined) {
    return throwHttpError(404, notFound(`No model row for "${profileKey}".`));
  }
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const result = await quarantineUpstream({
    profileKey,
    provider: body.provider,
    transport: body.transport ?? state.transport,
    kind: body.kind ?? DEFAULT_QUARANTINE_KIND,
    reason:
      body.reason ??
      `Quarantined by hand from the admin console on ${now.toISOString().slice(0, 10)}.`,
    actor,
    now,
  });
  const wire = {
    ...result,
    outcome: toWireQuarantineOutcome(result.outcome),
    consequences: result.consequences.map(toWireConsequence),
  };
  if (result.outcome.kind === "already-quarantined") {
    return c.json(wire, 409);
  }
  return c.json(wire, 200);
});

const releaseOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-live-row") }),
  z.object({
    kind: z.literal("not-quarantined"),
    /** Quarantine is per transport, so this names the ones on the others. */
    elsewhere: z.array(quarantineEntrySchema),
  }),
  z.object({
    kind: z.literal("released"),
    entry: quarantineEntrySchema,
    poolRenarrowed: z.boolean(),
    lastResortLifted: z.boolean(),
  }),
]);

const toWireReleaseOutcome = (
  outcome: ReleaseOutcome,
): z.infer<typeof releaseOutcomeSchema> => {
  if (outcome.kind === "no-live-row") return outcome;
  if (outcome.kind === "not-quarantined") {
    return { ...outcome, elsewhere: outcome.elsewhere.map(toWireQuarantine) };
  }
  return { ...outcome, entry: toWireQuarantine(outcome.entry) };
};

const releaseRoute = createRoute({
  method: "post",
  path: "/models/{profileKey}/release",
  summary: "Put a quarantined upstream back in the pool (super-admin)",
  tags: ["Model admin"],
  request: {
    params: profileKeyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string().min(1).max(64),
            transport: servedTransportSchema.optional(),
            reason: z.string().min(1).max(500).optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: writeResponses(
    releaseOutcomeSchema,
    "Released. Refusing with `not-quarantined` carries the entries on the OTHER transports, which is usually the transport the caller meant.",
  ),
});

modelAdminRoutes.openapi(releaseRoute, async (c) => {
  const { profileKey } = c.req.valid("param");
  const body = c.req.valid("json");
  const now = new Date();
  const state = await readLiveStateRow(profileKey);
  if (state === undefined) {
    return throwHttpError(404, notFound(`No model row for "${profileKey}".`));
  }
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  const result = await releaseUpstream({
    profileKey,
    provider: body.provider,
    transport: body.transport ?? state.transport,
    reason:
      body.reason ??
      `Released by hand from the admin console on ${now.toISOString().slice(0, 10)}.`,
    actor,
    now,
  });
  const wire = {
    ...result,
    outcome: toWireReleaseOutcome(result.outcome),
    consequences: result.consequences.map(toWireConsequence),
  };
  if (result.outcome.kind === "released") return c.json(wire, 200);
  return c.json(wire, 409);
});

// ---------------------------------------------------------------------------
// Acknowledge alerts
// ---------------------------------------------------------------------------

const ackRoute = createRoute({
  method: "post",
  path: "/alerts/ack",
  summary: "Stop the digest carrying these alerts (super-admin)",
  tags: ["Model admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            alertIds: z.array(z.uuid()).min(1).max(200),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(
              z.object({
                alertId: z.string(),
                outcome: z.discriminatedUnion("kind", [
                  z.object({ kind: z.literal("unknown-alert") }),
                  z.object({
                    kind: z.literal("acknowledged"),
                    alertKind: z.string(),
                    modelKey: z.string().nullable(),
                  }),
                  bulkFailureSchema,
                ]),
              }),
            ),
          }),
        },
      },
      description:
        "Acknowledging changes nothing about the DECISION an alert reports: a quarantine stays in force until its re-probe releases it.",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

modelAdminRoutes.openapi(ackRoute, async (c) => {
  const { alertIds } = c.req.valid("json");
  const actor: ModelWriteActor = {
    kind: "operator",
    userId: c.get("user").id,
  };
  return c.json(
    { entries: await acknowledgeModelAlerts({ alertIds, actor }) },
    200,
  );
});

export { modelAdminRoutes };
