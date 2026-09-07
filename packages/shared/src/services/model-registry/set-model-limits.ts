import { eq } from "drizzle-orm";
import db from "../../db";
import {
  type NewModelLiveStateRow,
  modelLiveState,
} from "../../db/schema/model-registry";
import { cacheEvidenceFor } from "../../model-registry/measures";
import { requirementsFor } from "../../model-registry/requirements";
import type {
  DroppedEndpoint,
  EndpointStat,
  LiveModelState,
  ModelLimits,
  SetModelLimitsOutcome,
} from "../../model-registry/types";
import { activeQuarantines } from "./breaker";
import { invalidateLiveRegistry, readLiveStateRow } from "./live";
import { computeCreditMultiplier } from "./sync/compute";
import { recomputeRowPool } from "./sync/recompute";

/**
 * Set the operator limits on one model, and re-derive its pool on the spot.
 *
 * The point of applying it immediately rather than at the next sync: a person
 * sets a ceiling BECAUSE a host is costing them money now, and a setting that
 * takes effect tonight is a setting they will not trust. The recompute runs
 * through `recomputeRowPool` — the same pure function the nightly pass uses —
 * so the pool this writes is the pool the sync would have written, and neither
 * can drift from the other.
 *
 * It recomputes from the STORED endpoint statistics rather than fetching: those
 * are what the last sync measured, they are what every other surface displays,
 * and reaching four public APIs to answer a form submission would make an
 * operator action depend on an upstream being awake.
 */

/** Exclusion reasons the operator limits produce, by their stable prefixes. */
const LIMIT_REASON_PREFIXES = ["operator cap:", "job floor:"] as const;

const droppedByLimits = (
  excluded: readonly DroppedEndpoint[],
): DroppedEndpoint[] =>
  excluded.filter((entry) =>
    LIMIT_REASON_PREFIXES.some((prefix) => entry.reason.startsWith(prefix)),
  );

const sameLimits = (a: ModelLimits, b: ModelLimits): boolean =>
  a.maxInputPricePerMTok === b.maxInputPricePerMTok &&
  a.maxOutputPricePerMTok === b.maxOutputPricePerMTok &&
  a.minMaxOutput === b.minMaxOutput &&
  a.minContextLength === b.minContextLength &&
  a.requireCache === b.requireCache;

const limitsOf = (row: LiveModelState): ModelLimits => ({
  maxInputPricePerMTok: row.maxInputPricePerMTok,
  maxOutputPricePerMTok: row.maxOutputPricePerMTok,
  minMaxOutput: row.minMaxOutput,
  minContextLength: row.minContextLength,
  requireCache: row.requireCache,
});

const cheapest = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.min(...values);

/**
 * Which pool members `requireCache` is keeping only because nothing has
 * observed them yet. Named so the operator knows the switch has not finished
 * its work rather than assuming every survivor is proven.
 */
const unprovenCacheProviders = (
  requireCache: boolean,
  endpoints: readonly EndpointStat[],
): string[] =>
  requireCache
    ? endpoints
        .filter((endpoint) => cacheEvidenceFor(endpoint).verdict === "unknown")
        .map((endpoint) => endpoint.provider)
    : [];

/**
 * Whether `next` permits anything `current` refused, in any dimension.
 *
 * Compared on the EFFECTIVE requirements, never on the stored overrides: what
 * a host has to clear is what the bound roles imply once the overrides are
 * applied, so clearing an override that was HARSHER than its role loosens the
 * rule, and clearing one that was softer tightens it. Reading the columns alone
 * would get both backwards.
 */
const isLooser = (
  row: LiveModelState,
  current: ModelLimits,
  next: ModelLimits,
): boolean => {
  const raised = (
    from: number | null | undefined,
    to: number | null | undefined,
  ): boolean =>
    from !== null &&
    from !== undefined &&
    (to === null || to === undefined || to > from);
  const lowered = (from: number | undefined, to: number | undefined): boolean =>
    from !== undefined && (to === undefined || to < from);

  const before = requirementsFor(row.boundRoles, current);
  const after = requirementsFor(row.boundRoles, next);
  return (
    raised(current.maxInputPricePerMTok, next.maxInputPricePerMTok) ||
    raised(current.maxOutputPricePerMTok, next.maxOutputPricePerMTok) ||
    lowered(before.minMaxOutput, after.minMaxOutput) ||
    lowered(before.minContextLength, after.minContextLength) ||
    (before.requireCache === true && after.requireCache !== true)
  );
};

interface Evaluation {
  outcome: SetModelLimitsOutcome;
  /** Present only when the caller should write it. */
  write?: Partial<NewModelLiveStateRow>;
  unprovenCache: string[];
  /**
   * The limits were loosened and nothing came back — so whatever they were
   * holding out is not in the stored measurements any more and returns only
   * once the catalogue is re-read.
   */
  awaitsSync: boolean;
}

/**
 * Decide what setting `limits` on this row would do. No writes, no clock reads
 * beyond the one passed in — so the preflight and the write cannot disagree
 * about what is about to happen.
 */
const evaluate = (
  row: LiveModelState,
  limits: ModelLimits,
  now: Date,
): Evaluation => {
  const endpoints = row.endpointStats;
  const quarantined = activeQuarantines(row, now)
    .filter((entry) => entry.transport === row.transport)
    .map((entry) => entry.provider);

  const { pool, vettedPool, context, pricing } = recomputeRowPool({
    row: { ...row, ...limits },
    endpoints,
    transport: row.transport,
    quarantined,
  });

  const dropped = droppedByLimits(pool.excluded);

  // What the pool is under the limits the row carries TODAY. Only used to tell
  // "loosening let a host back in" from "loosening changed nothing because the
  // last sync already pruned that host out of the measurements".
  const before = recomputeRowPool({
    row,
    endpoints,
    transport: row.transport,
    quarantined,
  });
  const awaitsSync =
    isLooser(row, limitsOf(row), limits) &&
    pool.endpoints.length <= before.pool.endpoints.length;

  // Refuse only when the limits are what emptied the pool. A row whose
  // endpoints have never been fetched has an empty pool whatever the limits
  // say, and refusing there would make the form unusable on exactly the models
  // an operator most wants to configure before promoting.
  if (endpoints.length > 0 && pool.endpoints.length === 0) {
    return {
      outcome: {
        kind: "cap-empties-pool",
        limits,
        cheapestInputPerMTok: cheapest(
          endpoints.map((endpoint) => endpoint.pricing.inputPerMTok),
        ),
        cheapestOutputPerMTok: cheapest(
          endpoints.map((endpoint) => endpoint.pricing.outputPerMTok),
        ),
        wouldDrop: dropped,
      },
      unprovenCache: [],
      awaitsSync: false,
    };
  }

  // Same guards the sync applies to its own writes, for the same reasons: an
  // empty computed pool never overwrites a working one, and a zero price has
  // always meant a parse failure rather than a free model.
  const zeroPrice = pricing.inputPerMTok <= 0 || pricing.outputPerMTok <= 0;
  const pricingToWrite = zeroPrice ? row.pricing : pricing;

  return {
    outcome: {
      kind: "updated",
      limits,
      dropped,
      remaining: pool.endpoints.length,
      pricing: pricingToWrite,
    },
    write: {
      maxInputPricePerMTok: limits.maxInputPricePerMTok,
      maxOutputPricePerMTok: limits.maxOutputPricePerMTok,
      minMaxOutput: limits.minMaxOutput,
      minContextLength: limits.minContextLength,
      requireCache: limits.requireCache,
      source: "admin",
      ...(vettedPool === undefined
        ? {}
        : {
            providerPool: {
              ...row.providerPool,
              [row.transport]: vettedPool,
            },
            // `endpointStats` is deliberately NOT narrowed to the survivors.
            //
            // It is the INPUT to this recompute, so writing the filtered list
            // back would make every limit change one-way: raising a cap would
            // recompute over a list the previous save had already pruned, and
            // the host it had excluded could never return. That is the ratchet
            // `poolJudgments` exists to prevent, arriving through a different
            // door — and it is worse here, because the operator would watch a
            // setting they just cleared change nothing.
            //
            // The sync narrows it, and may: it re-fetches every endpoint from
            // the catalogue first, so its input is never the pruned list.
            effectiveContextLength: context.contextLength,
            effectiveMaxOutput: context.maxOutput,
            pricing: pricingToWrite,
            creditMultiplier: computeCreditMultiplier(pricingToWrite),
            // Only the exclusion list is patched. The RULES stay as the last
            // sync graded them: nothing here re-ran a policy, and a report
            // half-refreshed would read as a verdict nobody reached.
            ...(row.policyReport === null
              ? {}
              : {
                  policyReport: {
                    ...row.policyReport,
                    excludedProviders: pool.excluded,
                  },
                }),
          }),
    },
    unprovenCache: unprovenCacheProviders(
      requirementsFor(row.boundRoles, limits).requireCache === true,
      pool.endpoints,
    ),
    awaitsSync,
  };
};

export interface ModelLimitsResult {
  outcome: SetModelLimitsOutcome;
  /** Pool members kept only for want of evidence — see `cache-unproven-kept`. */
  unprovenCache: string[];
  /** A loosened limit that freed nobody: the host returns on the next pass. */
  awaitsSync: boolean;
}

/** What setting these limits WOULD do. Writes nothing. */
export const forecastModelLimits = async (
  profileKey: string,
  limits: ModelLimits,
  now: Date = new Date(),
): Promise<ModelLimitsResult> => {
  const row = await readLiveStateRow(profileKey);
  if (!row) {
    return {
      outcome: { kind: "unknown-model" },
      unprovenCache: [],
      awaitsSync: false,
    };
  }
  const { outcome, unprovenCache, awaitsSync } = evaluate(row, limits, now);
  return { outcome, unprovenCache, awaitsSync };
};

export const setModelLimits = async (
  profileKey: string,
  limits: ModelLimits,
  now: Date = new Date(),
): Promise<ModelLimitsResult> => {
  const row = await readLiveStateRow(profileKey);
  if (!row) {
    return {
      outcome: { kind: "unknown-model" },
      unprovenCache: [],
      awaitsSync: false,
    };
  }

  if (sameLimits(limitsOf(row), limits)) {
    return {
      outcome: { kind: "unchanged", limits },
      unprovenCache: unprovenCacheProviders(
        requirementsFor(row.boundRoles, limits).requireCache === true,
        row.endpointStats,
      ),
      awaitsSync: false,
    };
  }

  const { outcome, write, unprovenCache, awaitsSync } = evaluate(
    row,
    limits,
    now,
  );
  if (write === undefined) return { outcome, unprovenCache, awaitsSync };

  await db
    .update(modelLiveState)
    .set(write)
    .where(eq(modelLiveState.profileKey, profileKey));
  // After the write, never inside it: an invalidation sent first tells every
  // replica to reload precisely the row that has not changed yet.
  await invalidateLiveRegistry();
  return { outcome, unprovenCache, awaitsSync };
};
