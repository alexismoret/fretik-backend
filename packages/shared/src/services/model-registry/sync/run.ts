import { eq } from "drizzle-orm";
import db from "../../../db";
import {
  type NewModelLiveStateRow,
  modelLiveState,
  modelSyncRuns,
} from "../../../db/schema/model-registry";
import type {
  CatalogueSource,
  MergedCatalogueEntry,
} from "../../../model-registry/catalogue";
import {
  catalogueMatchKey,
  mergeCatalogues,
} from "../../../model-registry/catalogue";
import { modelKeyForId } from "../../../model-registry/keys";
import {
  DEFAULT_CANDIDATE_POLICY,
  type ModelPolicy,
  PROMOTION_PRICE_CAPS,
  PUBLISHED_POLICY,
  computeHealthScore,
  evaluatePolicy,
  healthFromScore,
  promotionEnablement,
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
import { isTransportId } from "../../../model-registry/types";
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
import { createCatalogueSources, sourceForTransport } from "./sources";
import {
  fetchArtificialAnalysis,
  matchAaRecord,
} from "./sources/artificial-analysis";
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
  /** This pass's sources, holding their own per-pass state. */
  sources: CatalogueSource[];
  /**
   * Every model any transport serves, merged, keyed by `catalogueMatchKey`.
   *
   * Keyed on the FOLDED name rather than on an id, because an id belongs to one
   * transport and a model does not: `zai/glm-5.2`, `zai/glm-5.2` and `glm-5.2`
   * are three spellings the three catalogues use for one thing, and a map keyed
   * by id would hold it three times and answer "is this still listed" three
   * different ways.
   */
  catalog: Map<string, MergedCatalogueEntry>;
  /**
   * The transports whose catalogue actually answered this pass.
   *
   * Delisting is only detectable against a catalogue we READ. Without this,
   * one source outage would mark every row on that transport as removed and
   * raise a critical alert per model — the exact false alarm that makes an
   * alert channel worth ignoring.
   */
  catalogued: Set<TransportId>;
  aa: ReadonlyMap<string, AaMetrics>;
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

/**
 * Endpoints for one model on one transport, from that transport's own source.
 *
 * A transport with no source is an ERROR rather than an empty list: it means a
 * row names a transport this build cannot describe, and returning `[]` would
 * present that as a model nobody serves — which the caller would then write
 * back as a collapsed pool.
 */
const fetchEndpoints = async (
  ctx: SyncContext,
  transport: TransportId,
  modelId: string,
): Promise<EndpointStat[]> => {
  const source = sourceForTransport(ctx.sources, transport);
  if (source === undefined) {
    throw new Error(`no catalogue source for transport ${transport}`);
  }
  return source.fetchEndpoints(modelId);
};

/** The merged catalogue entry for a model, found by any id the row carries. */
const catalogueEntryFor = (
  ctx: SyncContext,
  modelIds: Partial<Record<TransportId, string>>,
): MergedCatalogueEntry | undefined => {
  for (const id of Object.values(modelIds)) {
    const entry = ctx.catalog.get(catalogueMatchKey(id));
    if (entry !== undefined) return entry;
  }
  return undefined;
};

/**
 * When the model came out, from whichever source knows.
 *
 * The catalogues are preferred because they date almost everything they list
 * (239 of 239 gateway models on 2026-08-30) and they list exactly what we can
 * route to. Artificial Analysis covers the rest. `undefined` when neither
 * answered — which leaves the stored value untouched rather than blanking it.
 */
const releaseDateFor = (
  entry: MergedCatalogueEntry | undefined,
  aa: AaMetrics | null,
): Date | undefined => {
  if (entry?.releasedAt !== undefined) return entry.releasedAt;
  if (aa?.releaseDate === undefined) return undefined;
  const parsed = new Date(aa.releaseDate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
        const outcome = await releaseProvider({
          modelKey: row.profileKey,
          provider: entry.provider,
          transport: entry.transport,
          reason: `Release re-probe pinned to ${entry.provider} succeeded ${ctx.now.toISOString().slice(0, 10)}.`,
          actor: { kind: "sync" },
        });
        // The entry was on the row when this pass read it, so anything but a
        // release means somebody else got there first between the two reads.
        // Benign — and not an `errors` entry, which would downgrade the whole
        // run to `partial` over a race that resolved the way we wanted.
        if (outcome.kind !== "released") {
          console.info(
            `[model-sync] release ${row.profileKey}/${entry.provider}: ${outcome.kind} — already handled elsewhere`,
          );
        }
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
    primary = await fetchEndpoints(ctx, transport, modelId);
  } catch (err: unknown) {
    ctx.stats.errors.push(`${row.profileKey}: ${message(err)}`);
    return;
  }

  // Every OTHER transport that serves this model is ENRICHMENT — it costs a
  // `quantization` column or a wire name, not the model's refresh, so a failure
  // is recorded and the pass continues.
  //
  // Enumerated from the row rather than from a pair, because there is no pair
  // any more: a model can be served by an aggregator and by a direct host at
  // once, and the previous `transport === "gateway" ? "openrouter" : "gateway"`
  // silently ignored any third id the row carried.
  let enrichment: EndpointStat[] = [];
  for (const [other, otherId] of Object.entries(row.modelIds)) {
    if (other === transport || !isTransportId(other)) continue;
    try {
      enrichment = mergeEndpointStats(
        enrichment,
        await fetchEndpoints(ctx, other, otherId),
      );
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

  const aa = matchAaRecord(ctx.aa, {
    aaSlug: row.aaSlug,
    profileKey: row.profileKey,
    modelIds: Object.values(row.modelIds),
  });
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

  // Delisting is asked of the transport the model actually runs on, and only
  // when that transport's catalogue answered this pass. It used to be asked of
  // the gateway for every row, which was wrong in both directions: a row served
  // by another transport was judged against a catalogue it has no reason to
  // appear in, and a model withdrawn from its own transport went unnoticed.
  const catalogEntry = catalogueEntryFor(ctx, row.modelIds);
  const removedFromCatalog =
    row.status === "published" &&
    ctx.catalogued.has(transport) &&
    catalogEntry?.idsByTransport[transport] === undefined;
  if (removedFromCatalog) {
    await ctx.alert({
      kind: "catalog-removed",
      severity: "critical",
      modelKey: row.profileKey,
      message: `${row.profileKey} names a model the ${transport} catalogue no longer lists. It is marked failing but stays enabled — pick its replacement before turning it off.`,
      context: { transport, modelId },
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
  //
  // `ignore` is CARRIED FORWARD rather than recomputed, because it is a
  // judgment and `only` is a measurement. Dropping it each pass — which this
  // did until 2026-08-30 — left the exclusion standing only as an accident of
  // the computed list: the host was absent from `only` because the `ignore`
  // had been applied on the pass that then erased it. Self-perpetuating while
  // nothing moves, and gone the moment `poolWidened` fires, since a widened
  // pool skips `only` and there would be no `ignore` left to catch the host
  // the exclusion existed for.
  const vettedPool: ProviderPool | undefined =
    pool.endpoints.length > 0
      ? {
          only: [
            ...new Set(pool.endpoints.map((endpoint) => endpoint.provider)),
          ],
          sort: "throughput",
          ...(declaredPool?.ignore !== undefined &&
          declaredPool.ignore.length > 0
            ? { ignore: declaredPool.ignore }
            : {}),
        }
      : undefined;

  // Ids for transports this model is now known to be served by.
  //
  // PURELY ADDITIVE, and that is the whole design: an id already on the row is
  // what routing uses today and what a transport switch would move to, so it is
  // never overwritten by a catalogue's spelling — the folded-name match is good
  // enough to discover a model and not good enough to re-point a working one.
  // Removal is not done here either; a model leaving a catalogue is delisting,
  // which alerts above and deliberately changes nothing.
  //
  // Without this, transports could only ever be gained at DISCOVERY. A model
  // already tracked when a new transport appeared stayed unreachable there
  // forever: on 2026-08-30, `glm-5.2` and `gpt-oss-120b` were published on
  // OpenRouter and served by Scaleway, and moving either to EU hosting meant
  // someone typing the id by hand — the same defect as unpromotable candidates,
  // seen from the other end.
  const gainedIds: Partial<Record<TransportId, string>> = {};
  for (const [transportId, id] of Object.entries(
    catalogEntry?.idsByTransport ?? {},
  )) {
    if (!isTransportId(transportId) || row.modelIds[transportId] !== undefined)
      continue;
    gainedIds[transportId] = id;
  }

  const update: Partial<NewModelLiveStateRow> = {
    ...(Object.keys(gainedIds).length === 0
      ? {}
      : { modelIds: { ...row.modelIds, ...gainedIds } }),
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
  // The catalogues own the release date — between them they list every model we
  // can route to and date almost all of them — with AA covering the rest. Same
  // rule as the grades above: a date we could not read this pass leaves the
  // stored one alone rather than blanking a column the picker sorts on.
  const released = releaseDateFor(catalogEntry, aa);
  if (released !== undefined) update.releasedAt = released;
  // The catalogue's DESCRIPTION of the model, refreshed every pass rather than
  // written once at discovery.
  //
  // It used to be written on the insert alone, which left every row frozen at
  // the shape of the catalogue on the day it was found: a model discovered
  // before the reasoning contract was parsed could never gain a depth menu, and
  // a seeded row — never discovered — carried no description at all, so its
  // card displayed a raw key. Refreshing is safe because this is a DESCRIPTION,
  // not a decision: everything a person or a detector decided (the transport,
  // the quarantines, the pool's `ignore`) is written elsewhere on the row and
  // carried forward, never recomputed from a catalogue.
  //
  // Since 2026-08-30 it is also load-bearing rather than cosmetic: with the
  // curated TypeScript profiles deleted, a row with no `dynamicProfile` is not
  // a model with a missing display name — it is not a servable model at all.
  if (catalogEntry !== undefined) {
    update.dynamicProfile = deriveDynamicProfile(catalogEntry, ctx.now);
  }
  if (quarantines !== undefined) update.quarantinedProviders = quarantines;
  if (zdrProbe !== undefined) {
    update.zdrProbeOk = zdrProbe.ok;
    update.zdrProbeAt = ctx.now;
  }

  // Price moves — upstreams reprice, run promotions, change tiers — so the
  // budget question is asked every night rather than once at promotion. Without
  // it, a model promoted at $1.90 that later rose to $3 would stay enabled
  // forever while an identical model discovered the next day arrived disabled:
  // one fleet, two answers, decided by nothing but arrival order.
  //
  // DELIBERATELY ONE-WAY. Disabling protects the bill and any operator undoes
  // it with one command; ENABLING spends money, and here it would overturn a
  // judgement this rule cannot see. `disabledReason: "cost"` is written by two
  // different authorities — curation, from a profile's `assessment`, and this
  // budget check — and the row does not record which. Four of the ten
  // cost-disabled models on 2026-08-30 price UNDER these caps
  // (claude-haiku-4.5 at $1.10/$5.50, gemini-3.7-flash, inkling,
  // mistral-medium-3.5), because curation judged them on estimated cost per
  // TURN rather than on a per-MTok ceiling. Auto-enabling would have silently
  // reversed all four. So a price falling back under budget raises an alert and
  // waits for a person.
  if (row.status === "published") {
    const budget = promotionEnablement(pricingToWrite);
    const priced = `$${pricingToWrite.inputPerMTok.toString()}/$${pricingToWrite.outputPerMTok.toString()} per MTok against a budget of $${PROMOTION_PRICE_CAPS.inputPerMTok.toString()}/$${PROMOTION_PRICE_CAPS.outputPerMTok.toString()}`;
    if (row.enabled && !budget.enabled) {
      if (row.boundRoles.length > 0) {
        // Same rule as every other automatic disable: never take the fleet down
        // to save money — ask a person.
        await ctx.alert({
          kind: "policy-fail",
          severity: "critical",
          modelKey: row.profileKey,
          message: `${row.profileKey} now costs ${priced}, and the fleet runs on it (${row.boundRoles.join(", ")}). It stays enabled — rebind the role or accept the price.`,
          context: { pricing: pricingToWrite, boundRoles: row.boundRoles },
        });
      } else {
        update.enabled = false;
        update.disabledReason = "cost";
        await ctx.alert({
          kind: "model-disabled",
          severity: "warning",
          modelKey: row.profileKey,
          message: `${row.profileKey} disabled on cost: ${priced}. Re-enable it by hand to keep paying for it.`,
          context: { pricing: pricingToWrite },
        });
      }
    } else if (
      !row.enabled &&
      row.disabledReason === "cost" &&
      budget.enabled
    ) {
      await ctx.alert({
        kind: "price-jump",
        severity: "info",
        modelKey: row.profileKey,
        message: `${row.profileKey} is disabled on cost but now prices at ${priced}. Left disabled on purpose — enable it by hand if it was the price that ruled it out.`,
        context: { pricing: pricingToWrite },
      });
    }
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

/**
 * The transport the fleet actually runs on: the one most PUBLISHED rows use.
 *
 * Measured rather than configured, so it follows the fleet instead of having to
 * be kept in step with it. Candidates are excluded from the count on purpose —
 * they are exactly the rows whose transport is being decided here, and letting
 * them vote would make a bad first choice self-reinforcing.
 *
 * `undefined` on an empty fleet, which is a first boot, and there the source
 * order decides.
 */
const fleetTransport = (
  rows: readonly LiveModelState[],
): TransportId | undefined => {
  const counts = new Map<TransportId, number>();
  for (const row of rows) {
    if (row.status !== "published") continue;
    counts.set(row.transport, (counts.get(row.transport) ?? 0) + 1);
  }
  let best: { transport: TransportId; count: number } | undefined;
  for (const [transport, count] of counts) {
    if (best === undefined || count > best.count) best = { transport, count };
  }
  return best?.transport;
};

/**
 * Where a newly discovered model should START.
 *
 * The fleet's OWN transport, whenever that transport serves the model. This is
 * the whole promotion fix: discovery used to read one catalogue and record one
 * id, so on 2026-08-30 all 110 candidates carried a gateway id and nothing
 * else, against 22 published models routing entirely through OpenRouter.
 * Promoting any of them moved a model onto a transport the fleet does not use,
 * and stripped it of everything only the other catalogue publishes.
 *
 * Falling back to source ORDER rather than to a hardcoded name keeps the rule
 * honest for a model the fleet's transport does not serve — `pixtral-12b-2409`
 * exists on Scaleway alone — and keeps this function free of any opinion about
 * which transports exist.
 */
const startingTransport = (
  entry: MergedCatalogueEntry,
  fleet: TransportId | undefined,
  sources: readonly CatalogueSource[],
): TransportId | undefined => {
  if (fleet !== undefined && entry.idsByTransport[fleet] !== undefined)
    return fleet;
  return sources.find((source) => entry.idsByTransport[source.id] !== undefined)
    ?.id;
};

/**
 * Look for models worth a human's attention: language models some catalogue
 * lists that no row already names, graded against the strict discovery policy.
 *
 * Nothing is ever published. `candidate` rows are invisible to teams until
 * someone promotes them, because tool-calling accuracy for one model spans
 * 22 % to 37 % depending on the host and a catalogue entry says nothing about
 * which host you get.
 */
const discoverCandidates = async (
  ctx: SyncContext,
  known: Set<string>,
  fleet: TransportId | undefined,
): Promise<void> => {
  const unknown = [...ctx.catalog.values()]
    .filter(
      (entry) =>
        // `undefined` is UNKNOWN, not "not a language model": only the gateway
        // and Scaleway classify, so rejecting the unclassified would make every
        // OpenRouter-only model undiscoverable. An embedding model that slips
        // through is caught by the policy — it advertises no `tools`.
        entry.isLanguageModel !== false &&
        entry.deprecated !== true &&
        ![...Object.values(entry.idsByTransport)].some((id) => known.has(id)),
    )
    // A catalogue's own `none` is a fact we can act on without spending a
    // request: the discovery policy requires zero retention, so a model with no
    // ZDR route anywhere cannot become a candidate.
    .filter((entry) => entry.zdr !== "none")
    // Newest first: with a bounded budget, the models worth discovering are the
    // ones that did not exist at the last sync.
    .sort(
      (a, b) => (b.releasedAt?.getTime() ?? 0) - (a.releasedAt?.getTime() ?? 0),
    );

  let fetches = 0;
  for (const entry of unknown) {
    if (
      fetches >= MAX_DISCOVERY_ENDPOINT_FETCHES ||
      ctx.stats.candidatesAdded >= MAX_NEW_CANDIDATES
    ) {
      break;
    }
    const transport = startingTransport(entry, fleet, ctx.sources);
    const modelId =
      transport === undefined ? undefined : entry.idsByTransport[transport];
    if (transport === undefined || modelId === undefined) continue;
    fetches += 1;
    let endpoints: EndpointStat[];
    try {
      endpoints = await fetchEndpoints(ctx, transport, modelId);
    } catch (err: unknown) {
      ctx.stats.errors.push(`discovery ${modelId}: ${message(err)}`);
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
    // A candidate has no curated slug yet — nobody has looked at it. Every id
    // it is known by is offered, because the transports spell the same model
    // differently and Artificial Analysis matches only one of the spellings.
    const aa = matchAaRecord(ctx.aa, {
      profileKey: entry.id,
      modelIds: Object.values(entry.idsByTransport),
    });
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
    const profileKey = modelKeyForId(entry.id);

    if (!ctx.dryRun) {
      await db
        .insert(modelLiveState)
        .values({
          profileKey,
          status: "candidate",
          transport,
          enabled: false,
          // EVERY id, not just the one discovery happened to fetch through, so
          // a promoted model can be moved between transports by a single write
          // instead of needing someone to look its other spellings up.
          modelIds: entry.idsByTransport,
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
          releasedAt: releaseDateFor(entry, aa) ?? null,
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
      message: `${modelId} passes the discovery policy on ${transport}: ${pool.endpoints.length.toString()} endpoint(s), ${context.contextLength.toString()} usable context, $${pricing.inputPerMTok.toString()}/$${pricing.outputPerMTok.toString()} per MTok${aa?.intelligenceIndex === undefined ? "" : `, intelligence ${aa.intelligenceIndex.toFixed(1)}`}. Added as a candidate — publish it by hand after a bench run.`,
      context: { transport, modelIds: entry.idsByTransport },
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

  // Every catalogue, in parallel, each failing on its own.
  //
  // ONE source failing is survivable and must be: its models keep yesterday's
  // values, its transport is excluded from delisting detection, and the other
  // transports refresh normally. ALL of them failing is the case the run must
  // refuse — a sync that can see no catalogue at all has no business rewriting
  // what the fleet routes on.
  const sources = createCatalogueSources();
  const catalogued = new Set<TransportId>();
  const listings = (
    await Promise.all(
      sources.map(async (source) => {
        try {
          const entries = await source.listModels();
          catalogued.add(source.id);
          return { source, entries };
        } catch (err: unknown) {
          stats.errors.push(`${source.id} catalogue: ${message(err)}`);
          return undefined;
        }
      }),
    )
  ).filter((listing) => listing !== undefined);

  if (listings.length === 0) {
    await alert({
      kind: "sync-failed",
      severity: "critical",
      message: `Model sync aborted before writing anything: no catalogue could be read (${stats.errors.join("; ")})`,
    });
    return finish("failed");
  }

  const ctx: SyncContext = {
    now,
    dryRun,
    skipZdrProbe: options?.skipZdrProbe ?? false,
    stats,
    sources,
    catalog: new Map(
      mergeCatalogues(listings).map((entry) => [
        catalogueMatchKey(entry.id),
        entry,
      ]),
    ),
    catalogued,
    aa: await fetchArtificialAnalysis(),
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
      await discoverCandidates(ctx, known, fleetTransport(rows));
    } catch (err: unknown) {
      stats.errors.push(`discovery: ${message(err)}`);
    }
  }

  if (!dryRun) await invalidateLiveRegistry();
  return finish(stats.errors.length > 0 ? "partial" : "ok");
};
