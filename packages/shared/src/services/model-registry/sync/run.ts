import { eq } from "drizzle-orm";
import db from "../../../db";
import {
  type NewModelLiveStateRow,
  modelLiveState,
  modelSyncRuns,
} from "../../../db/schema/model-registry";
import {
  DEFAULT_CANDIDATE_POLICY,
  type ModelPolicy,
  PUBLISHED_POLICY,
  computeHealthScore,
  evaluatePolicy,
  healthFromScore,
} from "../../../model-registry/policy";
import { normalizeProviderList } from "../../../model-registry/provider-names";
import type {
  AaMetrics,
  EndpointStat,
  LiveModelState,
  ProviderPool,
  QuarantineEntry,
  TransportId,
} from "../../../model-registry/types";
import { type RaiseAlertInput, raiseModelAlert } from "../alerts";
import { activeQuarantines, releaseProvider } from "../breaker";
import { countIncidentsForModel } from "../incidents";
import { invalidateLiveRegistry, readAllLiveStateRows } from "../live";
import {
  buildAllowedPool,
  computeCreditMultiplier,
  computeEffectiveContext,
  computePoolPricing,
  deriveDynamicProfile,
  detectPriceJump,
  mergeEndpointStats,
} from "./compute";
import {
  fetchArtificialAnalysis,
  normalizeAaKey,
} from "./sources/artificial-analysis";
import {
  type GatewayCatalogEntry,
  fetchGatewayCatalog,
} from "./sources/gateway-catalog";
import { fetchGatewayEndpoints } from "./sources/gateway-endpoints";
import { fetchOpenRouterEndpoints } from "./sources/openrouter-endpoints";
import { fetchOpenRouterZdrRoutes } from "./sources/openrouter-zdr";
import {
  probeProviderReachable,
  probeZeroDataRetention,
} from "./sources/zdr-probe";

/**
 * The nightly sync: gather what is true about every model right now, grade it,
 * and write the half of model configuration a running process is allowed to
 * change.
 *
 * Three properties are load-bearing, and each is the answer to a way this could
 * make things worse rather than better:
 *
 * 1. **A dead source changes nothing.** An unreachable catalogue ends the run
 *    as `failed` with every existing row untouched. One unreachable MODEL costs
 *    that model its refresh and nothing else. The rows the fleet routes on are
 *    never rewritten from data we could not fetch.
 * 2. **Write guards, not just policy rules.** The invariants below used to be a
 *    unit test on the TypeScript registry — a published model always has a
 *    reachable endpoint, a usable context and a real price. Now that those
 *    values come from an API at 03:00, the test cannot hold them; a guard that
 *    keeps the previous value and shouts can.
 * 3. **Automation stops short of the fleet's neck.** The sync may disable a
 *    model nobody is bound to after a STREAK of hard failures. It may never
 *    disable a model an internal role runs on, and it never publishes anything:
 *    day-zero endpoints are measurably unstable, so discovery is automatic and
 *    publication is a person's decision.
 */

/** The invariants of a published row, enforced at the write rather than in a test. */
const MIN_EFFECTIVE_CONTEXT_TOKENS = 32_000;

/**
 * Consecutive syncs whose HARD rules failed before an automatic disable. One
 * bad night is a vendor hiccup; two in a row is a state.
 */
const DISABLE_STREAK = 2;

/** Extension applied when a quarantined provider fails its release re-probe. */
const QUARANTINE_EXTENSION_DAYS = 7;

/**
 * Discovery budget. The catalogue holds ~240 language models and most of them
 * are already known or uninteresting; an endpoints call each would turn a
 * bounded nightly job into a hundreds-of-requests crawl against a public API.
 */
const MAX_DISCOVERY_ENDPOINT_FETCHES = 40;
const MAX_NEW_CANDIDATES = 20;

export interface ModelSyncOptions {
  now?: Date;
  /** Restrict the pass to these profile keys — for `model-admin`, and for tests. */
  onlyKeys?: string[];
  /** Compute and log everything, write nothing but the run row. */
  dryRun?: boolean;
  skipZdrProbe?: boolean;
}

export interface ModelSyncStats {
  modelsSeen: number;
  /** Rows the pass decided to write. `dryRun` decides but does not write. */
  modelsUpdated: number;
  candidatesAdded: number;
  policyFailures: number;
  quarantinesReleased: number;
  alerts: number;
  errors: string[];
}

export interface ModelSyncResult {
  status: "ok" | "partial" | "failed";
  stats: ModelSyncStats;
}

interface SyncContext {
  now: Date;
  dryRun: boolean;
  skipZdrProbe: boolean;
  stats: ModelSyncStats;
  catalog: Map<string, GatewayCatalogEntry>;
  aa: ReadonlyMap<string, AaMetrics>;
  /**
   * OpenRouter's zero-retention routes for the WHOLE catalogue, fetched once
   * per pass. `undefined` means the source could not be read, which leaves
   * every stance unset rather than claiming nothing is zero-retention.
   */
  zdrRoutes: Set<string> | undefined;
  /** Previous streaks, keyed by profile key — not carried by `LiveModelState`. */
  streaks: Map<string, number>;
  alert: (input: RaiseAlertInput) => Promise<void>;
}

const emptyStats = (): ModelSyncStats => ({
  modelsSeen: 0,
  modelsUpdated: 0,
  candidatesAdded: 0,
  policyFailures: 0,
  quarantinesReleased: 0,
  alerts: 0,
  errors: [],
});

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Endpoints for one model on one transport, from that transport's own API. */
const fetchEndpoints = async (
  transport: TransportId,
  modelId: string,
  zdrRoutes: Set<string> | undefined,
): Promise<EndpointStat[]> => {
  if (transport === "gateway") return fetchGatewayEndpoints(modelId);
  if (transport === "openrouter")
    return fetchOpenRouterEndpoints(modelId, zdrRoutes);
  throw new Error(`no endpoint source for transport ${transport}`);
};

/** The AA entry for a model, matched on the profile key then on each model id. */
const lookupAa = (
  aa: ReadonlyMap<string, AaMetrics>,
  profileKey: string,
  modelIds: string[],
): AaMetrics | null => {
  const keys = [
    profileKey,
    ...modelIds.flatMap((id) => [id, id.split("/").at(-1) ?? id]),
  ];
  for (const key of keys) {
    const hit = aa.get(normalizeAaKey(key));
    if (hit !== undefined) return hit;
  }
  return null;
};

/**
 * Re-probe every quarantine whose release date has passed, pinning the call to
 * the one provider. A clean probe releases it through the breaker's own
 * `releaseProvider` (which also re-narrows the pool and lifts `lastResort`); a
 * refusal extends the quarantine in place, because the release date is a review
 * trigger and not an amnesty.
 *
 * With no gateway key, NOTHING is released: a quarantine we cannot verify stays.
 * Returns the quarantine list to persist, or `undefined` when nothing changed.
 */
const reprobeExpiredQuarantines = async (
  ctx: SyncContext,
  row: LiveModelState,
): Promise<QuarantineEntry[] | undefined> => {
  const gatewayId = row.modelIds.gateway;
  const expired = row.quarantinedProviders.filter(
    (entry) => new Date(entry.releaseAt).getTime() <= ctx.now.getTime(),
  );
  if (expired.length === 0 || gatewayId === undefined) return undefined;

  const kept: QuarantineEntry[] = [...row.quarantinedProviders];
  let changed = false;

  for (const entry of expired) {
    let verdict: Awaited<ReturnType<typeof probeProviderReachable>>;
    try {
      verdict = await probeProviderReachable(gatewayId, entry.provider);
    } catch (err: unknown) {
      ctx.stats.errors.push(
        `${row.profileKey}: re-probe of ${entry.provider} failed: ${message(err)}`,
      );
      continue;
    }
    // No key, or a failure that says nothing about the provider: leave the
    // quarantine exactly as it is rather than releasing or extending blindly.
    if (verdict === undefined) continue;

    if (verdict.ok) {
      if (!ctx.dryRun) {
        await releaseProvider({
          modelKey: row.profileKey,
          provider: entry.provider,
          transport: entry.transport,
          reason: `Release re-probe pinned to ${entry.provider} succeeded ${ctx.now.toISOString().slice(0, 10)}.`,
        });
      }
      ctx.stats.quarantinesReleased += 1;
      const index = kept.indexOf(entry);
      if (index >= 0) kept.splice(index, 1);
      changed = true;
      continue;
    }

    const releaseAt = new Date(
      ctx.now.getTime() + QUARANTINE_EXTENSION_DAYS * 24 * 60 * 60_000,
    ).toISOString();
    const index = kept.indexOf(entry);
    if (index >= 0) kept[index] = { ...entry, releaseAt };
    changed = true;
    await ctx.alert({
      kind: "release-failed",
      severity: "warning",
      modelKey: row.profileKey,
      provider: entry.provider,
      message: `${entry.provider} still refuses ${row.profileKey} on its release date — quarantine extended to ${releaseAt.slice(0, 10)}. ${verdict.detail}`,
    });
  }

  return changed ? kept : undefined;
};

const syncOneModel = async (
  ctx: SyncContext,
  row: LiveModelState,
): Promise<void> => {
  ctx.stats.modelsSeen += 1;
  const transport = row.transport;
  const modelId = row.modelIds[transport];
  if (modelId === undefined) {
    ctx.stats.errors.push(
      `${row.profileKey}: no model id for its own transport (${transport})`,
    );
    return;
  }

  let primary: EndpointStat[];
  try {
    primary = await fetchEndpoints(transport, modelId, ctx.zdrRoutes);
  } catch (err: unknown) {
    ctx.stats.errors.push(`${row.profileKey}: ${message(err)}`);
    return;
  }

  // The other transport is ENRICHMENT — its failure costs a `quantization`
  // column, not the model's refresh, so it never aborts the pass.
  const other: TransportId = transport === "gateway" ? "openrouter" : "gateway";
  const otherId = row.modelIds[other];
  let enrichment: EndpointStat[] = [];
  if (otherId !== undefined) {
    try {
      enrichment = await fetchEndpoints(other, otherId, ctx.zdrRoutes);
    } catch (err: unknown) {
      ctx.stats.errors.push(
        `${row.profileKey}: enrichment from ${other} failed: ${message(err)}`,
      );
    }
  }
  const merged = mergeEndpointStats(primary, enrichment);

  const quarantines = await reprobeExpiredQuarantines(ctx, row);
  const quarantinedNames = activeQuarantines(
    { quarantinedProviders: quarantines ?? row.quarantinedProviders },
    ctx.now,
  )
    .filter((entry) => entry.transport === transport)
    .map((entry) => entry.provider);

  const policy: ModelPolicy =
    row.status === "published" ? PUBLISHED_POLICY : DEFAULT_CANDIDATE_POLICY;
  const declaredPool = row.providerPool[transport];
  const pool = buildAllowedPool({
    declaredPool,
    poolWidened: row.poolWidened,
    quarantined: quarantinedNames,
    endpoints: merged,
    requireTools: policy.toolCallingRequired,
    requireZdr: policy.zdrRequired,
    quantizationFloor: policy.quantizationFloor,
  });

  // A pool member no endpoint answers to is how a pool quietly changes meaning:
  // the routing keeps working, on a set nobody vetted.
  const seen = new Set(merged.map((endpoint) => endpoint.provider));
  const unknownProviders = normalizeProviderList(
    declaredPool?.only ?? [],
  ).filter((provider) => !seen.has(provider));
  if (unknownProviders.length > 0) {
    await ctx.alert({
      kind: "unknown-provider",
      severity: "warning",
      modelKey: row.profileKey,
      message: `${row.profileKey} declares pool members no ${transport} endpoint matches: ${unknownProviders.join(", ")}. The pool now means something narrower than it reads.`,
      context: { transport, unknownProviders },
    });
  }

  // The probe is a gateway call by construction, so a model served elsewhere
  // gets no verdict rather than a verdict about a route it does not use.
  let zdrProbe: { ok: boolean; at: string } | undefined;
  if (!ctx.skipZdrProbe && transport === "gateway") {
    try {
      const verdict = await probeZeroDataRetention(modelId);
      if (verdict !== undefined) {
        zdrProbe = { ok: verdict.ok, at: ctx.now.toISOString() };
      }
    } catch (err: unknown) {
      ctx.stats.errors.push(
        `${row.profileKey}: ZDR probe failed: ${message(err)}`,
      );
    }
  }

  const aa = lookupAa(ctx.aa, row.profileKey, Object.values(row.modelIds));
  const report = evaluatePolicy(
    policy,
    {
      endpoints: pool.endpoints,
      excludedProviders: pool.excluded,
      aa,
      zdrProbe,
      requiresTools: true,
    },
    ctx.now,
  );

  let incidents24h = 0;
  try {
    incidents24h = await countIncidentsForModel(row.profileKey, ctx.now);
  } catch (err: unknown) {
    ctx.stats.errors.push(
      `${row.profileKey}: incident count failed: ${message(err)}`,
    );
  }

  const context = computeEffectiveContext(pool.endpoints);
  const pricing = computePoolPricing(pool.endpoints);

  // ---- Write guards. Each keeps the PREVIOUS value for its own field. ----
  const rejected = async (field: string, value: string): Promise<void> => {
    ctx.stats.policyFailures += 1;
    await ctx.alert({
      kind: "policy-fail",
      severity: "critical",
      modelKey: row.profileKey,
      message: `${row.profileKey}: refused to write ${field} = ${value}; kept the previous value. ${report.rules
        .filter((rule) => !rule.passed)
        .map((rule) => rule.detail)
        .join("; ")}`,
      context: { field, rejected: value, transport },
    });
  };

  const emptyPublishedPool =
    row.status === "published" && pool.endpoints.length === 0;
  if (emptyPublishedPool) {
    await rejected("endpointStats", "0 allowed endpoints");
  }
  const contextTooSmall = context.contextLength < MIN_EFFECTIVE_CONTEXT_TOKENS;
  if (contextTooSmall) {
    await rejected(
      "effectiveContextLength",
      `${context.contextLength.toString()} tokens`,
    );
  }
  // `0` is a legitimate catalogue price for a free model, and an illegitimate
  // one for everything we run — a zero here has always meant a parse or shape
  // failure, and billing a fleet off it is unrecoverable.
  const zeroPrice = pricing.inputPerMTok <= 0 || pricing.outputPerMTok <= 0;
  if (zeroPrice) {
    await rejected(
      "pricing",
      `$${pricing.inputPerMTok.toString()}/$${pricing.outputPerMTok.toString()} per MTok`,
    );
  }

  const pricingToWrite = zeroPrice ? row.pricing : pricing;
  const jump = detectPriceJump(row.pricing, pricingToWrite);
  if (jump !== null) {
    await ctx.alert({
      kind: "price-jump",
      severity: "warning",
      modelKey: row.profileKey,
      message: `${row.profileKey} blended price moved ${(jump * 100).toFixed(0)}% — $${row.pricing.inputPerMTok.toString()}/$${row.pricing.outputPerMTok.toString()} → $${pricingToWrite.inputPerMTok.toString()}/$${pricingToWrite.outputPerMTok.toString()} per MTok. The new price is in effect.`,
      context: { change: jump, previous: row.pricing, next: pricingToWrite },
    });
  }

  const gatewayId = row.modelIds.gateway;
  const removedFromCatalog =
    row.status === "published" &&
    gatewayId !== undefined &&
    !ctx.catalog.has(gatewayId);
  if (removedFromCatalog) {
    await ctx.alert({
      kind: "catalog-removed",
      severity: "critical",
      modelKey: row.profileKey,
      message: `${row.profileKey} names a gateway model the catalogue no longer lists. It is marked failing but stays enabled — pick its replacement before turning it off.`,
      context: { gatewayId },
    });
  }

  const healthScore = computeHealthScore({
    endpoints: pool.endpoints,
    report,
    incidents24h,
  });
  const streak =
    report.hardFailures > 0 ? (ctx.streaks.get(row.profileKey) ?? 0) + 1 : 0;

  // The vetted pool, written back so it reaches the WIRE rather than only the
  // statistics.
  //
  // It was computed every night and used for context, pricing and health while
  // routing kept whatever the profile declared by hand — which for 20 of 22
  // published models was nothing at all. An open pool with no ordering means
  // any host may serve any turn, which is how `gpt-oss-20b` was answered by
  // CoreWeave on 2026-08-29, three weeks after CoreWeave was found injecting
  // zero-width characters into another model's output. Nothing had excluded
  // it, and nothing had preferred anyone else.
  //
  // Two properties make an explicit list safe to write unattended. It is
  // DERIVED, so a host that appears tomorrow joins on the next pass instead of
  // waiting for a release — a hand-written list would need a PR per provider.
  // And it is ORDERED by throughput, which is what lets a slow host stay in as
  // a genuine last resort: routing only reaches it once everything faster is
  // unavailable, and serving slowly then beats refusing.
  //
  // `order` is deliberately not set alongside it: OpenRouter treats an explicit
  // order as the whole preference and silently ignores `sort`.
  const vettedPool: ProviderPool | undefined =
    pool.endpoints.length > 0
      ? {
          only: [
            ...new Set(pool.endpoints.map((endpoint) => endpoint.provider)),
          ],
          sort: "throughput",
        }
      : undefined;

  const update: Partial<NewModelLiveStateRow> = {
    endpointStats: emptyPublishedPool ? row.endpointStats : pool.endpoints,
    // An empty computed pool never overwrites a working one — same guard as
    // `endpointStats` above, for the same reason: a source outage must not
    // narrow routing to nothing.
    ...(vettedPool === undefined
      ? {}
      : {
          providerPool: { ...row.providerPool, [transport]: vettedPool },
        }),
    effectiveContextLength: contextTooSmall
      ? row.effectiveContextLength
      : context.contextLength,
    effectiveMaxOutput: contextTooSmall
      ? row.effectiveMaxOutput
      : context.maxOutput,
    pricing: pricingToWrite,
    creditMultiplier: computeCreditMultiplier(pricingToWrite),
    health: removedFromCatalog ? "failing" : healthFromScore(healthScore),
    healthScore,
    policyReport: report,
    policyFailStreak: streak,
    source: "sync",
    syncedAt: ctx.now,
  };
  // An Artificial Analysis outage returns an empty map, and writing `null` from
  // it would erase yesterday's grades fleet-wide. Absent stays absent; the
  // stored `fetchedAt` is what says how old a kept figure is.
  if (aa !== null) update.aaMetrics = aa;
  if (quarantines !== undefined) update.quarantinedProviders = quarantines;
  if (zdrProbe !== undefined) {
    update.zdrProbeOk = zdrProbe.ok;
    update.zdrProbeAt = ctx.now;
  }

  if (streak >= DISABLE_STREAK) {
    if (row.boundRoles.length > 0) {
      // Disabling here would take the chatbot down rather than degrade one
      // team's choice, so the engine stops and asks for a person.
      await ctx.alert({
        kind: "critical-role-model",
        severity: "critical",
        modelKey: row.profileKey,
        message: `${row.profileKey} has failed hard policy rules ${streak.toString()} syncs running and the fleet runs on it (${row.boundRoles.join(", ")}). It stays enabled — rebind the role or fix the pool. ${report.rules
          .filter((rule) => rule.severity === "hard" && !rule.passed)
          .map((rule) => rule.detail)
          .join("; ")}`,
        context: { boundRoles: row.boundRoles, streak },
      });
    } else if (row.status === "published" && row.enabled) {
      update.enabled = false;
      update.disabledReason = "policy";
      await ctx.alert({
        kind: "model-disabled",
        severity: "critical",
        modelKey: row.profileKey,
        message: `${row.profileKey} disabled after ${streak.toString()} consecutive syncs failing hard policy rules. No internal role is bound to it. ${report.rules
          .filter((rule) => rule.severity === "hard" && !rule.passed)
          .map((rule) => rule.detail)
          .join("; ")}`,
        context: { streak },
      });
    }
  }

  ctx.stats.modelsUpdated += 1;
  if (ctx.dryRun) {
    console.info(
      `[model-sync] dry-run ${row.profileKey}: ${pool.endpoints.length.toString()} endpoint(s), context ${(update.effectiveContextLength ?? 0).toString()}, health ${String(update.health)}, streak ${streak.toString()}`,
    );
    return;
  }
  await db
    .update(modelLiveState)
    .set(update)
    .where(eq(modelLiveState.profileKey, row.profileKey));
};

/** `alibaba/qwen-3-235b` → `alibaba-qwen-3-235b`, inside the 64-char key column. */
const candidateKey = (modelId: string): string =>
  modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

/**
 * Look for models worth a human's attention: language models in the catalogue
 * that no row already names, graded against the strict discovery policy.
 *
 * Nothing is ever published. `candidate` rows are invisible to teams until
 * someone promotes them, because tool-calling accuracy for one model spans
 * 22 % to 37 % depending on the host and a catalogue entry says nothing about
 * which host you get.
 */
const discoverCandidates = async (
  ctx: SyncContext,
  known: Set<string>,
): Promise<void> => {
  const unknown = [...ctx.catalog.values()]
    .filter((entry) => entry.type === "language" && !known.has(entry.id))
    // The catalogue's own `none` is a fact we can act on without spending a
    // request: the discovery policy requires zero retention, so a model with no
    // ZDR route anywhere cannot become a candidate.
    .filter((entry) => entry.zdr !== "none")
    // Newest first: with a bounded budget, the models worth discovering are the
    // ones that did not exist at the last sync.
    .sort((a, b) => (b.released ?? 0) - (a.released ?? 0));

  let fetches = 0;
  for (const entry of unknown) {
    if (
      fetches >= MAX_DISCOVERY_ENDPOINT_FETCHES ||
      ctx.stats.candidatesAdded >= MAX_NEW_CANDIDATES
    ) {
      break;
    }
    fetches += 1;
    let endpoints: EndpointStat[];
    try {
      endpoints = await fetchGatewayEndpoints(entry.id);
    } catch (err: unknown) {
      ctx.stats.errors.push(`discovery ${entry.id}: ${message(err)}`);
      continue;
    }

    const pool = buildAllowedPool({
      poolWidened: false,
      quarantined: [],
      endpoints,
      requireTools: DEFAULT_CANDIDATE_POLICY.toolCallingRequired,
      requireZdr: DEFAULT_CANDIDATE_POLICY.zdrRequired,
      quantizationFloor: DEFAULT_CANDIDATE_POLICY.quantizationFloor,
    });
    const aa = lookupAa(ctx.aa, entry.id, [entry.id]);
    const report = evaluatePolicy(
      DEFAULT_CANDIDATE_POLICY,
      {
        endpoints: pool.endpoints,
        excludedProviders: pool.excluded,
        aa,
        requiresTools: true,
      },
      ctx.now,
    );
    if (!report.passed) continue;

    const context = computeEffectiveContext(pool.endpoints);
    const pricing = computePoolPricing(pool.endpoints);
    const healthScore = computeHealthScore({
      endpoints: pool.endpoints,
      report,
      incidents24h: 0,
    });
    const profileKey = candidateKey(entry.id);

    if (!ctx.dryRun) {
      await db
        .insert(modelLiveState)
        .values({
          profileKey,
          status: "candidate",
          transport: "gateway",
          enabled: false,
          modelIds: { gateway: entry.id },
          providerPool: {},
          quarantinedProviders: [],
          effectiveContextLength: context.contextLength,
          effectiveMaxOutput: context.maxOutput,
          pricing,
          creditMultiplier: computeCreditMultiplier(pricing),
          health: healthFromScore(healthScore),
          healthScore,
          policyReport: report,
          endpointStats: pool.endpoints,
          aaMetrics: aa,
          dynamicProfile: deriveDynamicProfile(entry, ctx.now),
          boundRoles: [],
          source: "sync",
          syncedAt: ctx.now,
        })
        // A key that collides with an existing row is a model we already track
        // under another spelling; the row we have wins.
        .onConflictDoNothing();
    }
    ctx.stats.candidatesAdded += 1;
    await ctx.alert({
      kind: "new-candidate",
      severity: "info",
      modelKey: profileKey,
      message: `${entry.id} passes the discovery policy: ${pool.endpoints.length.toString()} endpoint(s), ${context.contextLength.toString()} usable context, $${pricing.inputPerMTok.toString()}/$${pricing.outputPerMTok.toString()} per MTok${aa?.intelligenceIndex === undefined ? "" : `, intelligence ${aa.intelligenceIndex.toFixed(1)}`}. Added as a candidate — publish it by hand after a bench run.`,
      context: { gatewayId: entry.id },
    });
  }
};

export const runModelSync = async (
  options?: ModelSyncOptions,
): Promise<ModelSyncResult> => {
  const now = options?.now ?? new Date();
  const dryRun = options?.dryRun ?? false;
  const stats = emptyStats();

  const alert = async (input: RaiseAlertInput): Promise<void> => {
    stats.alerts += 1;
    if (dryRun) {
      console.info(
        `[model-sync] dry-run alert ${input.kind} — ${input.message}`,
      );
      return;
    }
    await raiseModelAlert(input);
  };

  const [run] = await db
    .insert(modelSyncRuns)
    .values({ status: "running", startedAt: now })
    .returning({ id: modelSyncRuns.id });

  const finish = async (
    status: "ok" | "partial" | "failed",
  ): Promise<ModelSyncResult> => {
    if (run !== undefined) {
      await db
        .update(modelSyncRuns)
        .set({
          status,
          finishedAt: new Date(),
          stats: {
            modelsSeen: stats.modelsSeen,
            modelsUpdated: stats.modelsUpdated,
            candidatesAdded: stats.candidatesAdded,
            policyFailures: stats.policyFailures,
            quarantinesReleased: stats.quarantinesReleased,
            alerts: stats.alerts,
            errors: stats.errors,
          },
        })
        .where(eq(modelSyncRuns.id, run.id));
    }
    return { status, stats };
  };

  let entries: GatewayCatalogEntry[];
  try {
    entries = await fetchGatewayCatalog();
  } catch (err: unknown) {
    // Every row keeps yesterday's values. A sync that cannot see the catalogue
    // has no business rewriting what the fleet routes on.
    stats.errors.push(`gateway catalogue: ${message(err)}`);
    await alert({
      kind: "sync-failed",
      severity: "critical",
      message: `Model sync aborted before writing anything: ${message(err)}`,
    });
    return finish("failed");
  }

  const ctx: SyncContext = {
    now,
    dryRun,
    skipZdrProbe: options?.skipZdrProbe ?? false,
    stats,
    catalog: new Map(entries.map((entry) => [entry.id, entry])),
    aa: await fetchArtificialAnalysis(),
    // One fetch for the whole pass — the list covers the entire catalogue, so
    // per-model cost is zero. Unlike the gateway catalogue above, a failure
    // here does NOT abort: it costs a column, and the pool keeps the stance it
    // already had.
    zdrRoutes: await fetchOpenRouterZdrRoutes(),
    streaks: new Map(),
    alert,
  };

  const rows = await readAllLiveStateRows();
  // `LiveModelState` deliberately does not carry `policyFailStreak` — it is
  // sync bookkeeping, not something the read path should hand to a resolver —
  // so the previous streaks come from one extra projection rather than from a
  // second full read.
  const streakRows = await db
    .select({
      profileKey: modelLiveState.profileKey,
      policyFailStreak: modelLiveState.policyFailStreak,
    })
    .from(modelLiveState);
  for (const streak of streakRows) {
    ctx.streaks.set(streak.profileKey, streak.policyFailStreak);
  }

  const onlyKeys =
    options?.onlyKeys === undefined ? undefined : new Set(options.onlyKeys);
  const targeted = rows.filter(
    (row) => onlyKeys === undefined || onlyKeys.has(row.profileKey),
  );

  for (const row of targeted) {
    try {
      await syncOneModel(ctx, row);
    } catch (err: unknown) {
      // One model's unexpected failure is one model's stale row, never the run.
      stats.errors.push(`${row.profileKey}: ${message(err)}`);
    }
  }

  // Discovery only runs on a full pass: a targeted run is an operator looking
  // at one model, not an invitation to add twenty more.
  if (onlyKeys === undefined) {
    const known = new Set(rows.flatMap((row) => Object.values(row.modelIds)));
    try {
      await discoverCandidates(ctx, known);
    } catch (err: unknown) {
      stats.errors.push(`discovery: ${message(err)}`);
    }
  }

  if (!dryRun) await invalidateLiveRegistry();
  return finish(stats.errors.length > 0 ? "partial" : "ok");
};
