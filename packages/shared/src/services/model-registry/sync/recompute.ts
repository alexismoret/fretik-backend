import {
  DEFAULT_CANDIDATE_POLICY,
  type ModelPolicy,
  PUBLISHED_POLICY,
} from "../../../model-registry/policy";
import { requirementsFor } from "../../../model-registry/requirements";
import type {
  EndpointStat,
  LiveModelState,
  PricingSnapshot,
  ProviderPool,
  TransportId,
} from "../../../model-registry/types";
import {
  type AllowedPool,
  buildAllowedPool,
  computeEffectiveContext,
  computePoolPricing,
  poolJudgments,
} from "./compute";

/**
 * What one row's pool, price and usable context come to — computed ONCE, here.
 *
 * This was inline in `syncOneModel` and had exactly one caller, which was fine
 * while the nightly pass was the only thing that could change a pool. It is not
 * any more: an operator setting a price ceiling or demanding a proven cache
 * changes the same five outputs, and a second copy of this arithmetic is how
 * the pool an operator is shown stops matching the pool the next sync writes.
 * Both paths call this, so they cannot disagree.
 *
 * Pure by construction — no clock, no database, no network. The caller supplies
 * the quarantined hosts because the two callers know different things: the sync
 * has just re-probed them and holds a fresher list than the row does.
 */

/** The row fields the recompute reads. Everything else on the row is output. */
export type RecomputeRowState = Pick<
  LiveModelState,
  | "profileKey"
  | "status"
  | "providerPool"
  | "poolWidened"
  | "maxInputPricePerMTok"
  | "maxOutputPricePerMTok"
  | "minMaxOutput"
  | "minContextLength"
  | "requireCache"
  // Read to DERIVE the capability floors: what a host must be able to do is a
  // property of the jobs bound to the row, not a setting on it.
  | "boundRoles"
>;

export interface RecomputeRowInput {
  row: RecomputeRowState;
  /** Endpoints for THIS transport, already merged and carried forward. */
  endpoints: EndpointStat[];
  /** The transport being computed — not always `row.transport`, which may move. */
  transport: TransportId;
  /**
   * Hosts the breaker has out on this transport, normalised. Required rather
   * than derived from the row: the sync re-probes expired quarantines first and
   * would otherwise recompute against a list it has just superseded.
   */
  quarantined: string[];
}

export interface RecomputedRow {
  /** Which policy graded this row, so the caller evaluates against the same one. */
  policy: ModelPolicy;
  /** The carried-forward half of the stored pool: `ignore` and `sort`, never `only`. */
  judgments: ProviderPool;
  pool: AllowedPool;
  /** What to store for this transport, or `undefined` when nothing survived. */
  vettedPool: ProviderPool | undefined;
  context: { contextLength: number; maxOutput: number | null };
  pricing: PricingSnapshot;
}

export const recomputeRowPool = (input: RecomputeRowInput): RecomputedRow => {
  const { row, endpoints, transport, quarantined } = input;

  const policy =
    row.status === "published" ? PUBLISHED_POLICY : DEFAULT_CANDIDATE_POLICY;
  const judgments = poolJudgments(row.profileKey, row.providerPool[transport]);

  const pool = buildAllowedPool({
    declaredPool: judgments,
    poolWidened: row.poolWidened,
    quarantined,
    endpoints,
    requireTools: policy.toolCallingRequired,
    requireZdr: policy.zdrRequired,
    quantizationFloor: policy.quantizationFloor,
    ...(row.maxInputPricePerMTok === null
      ? {}
      : { maxInputPricePerMTok: row.maxInputPricePerMTok }),
    ...(row.maxOutputPricePerMTok === null
      ? {}
      : { maxOutputPricePerMTok: row.maxOutputPricePerMTok }),
    requirements: requirementsFor(row.boundRoles, {
      minMaxOutput: row.minMaxOutput,
      minContextLength: row.minContextLength,
      requireCache: row.requireCache,
    }),
  });

  // The vetted pool, in the shape that reaches the WIRE rather than only the
  // statistics.
  //
  // It was computed every night and used for context, pricing and health while
  // routing kept whatever the profile declared by hand — which for 20 of 22
  // published models was nothing at all. An open pool with no ordering means
  // any host may serve any turn, which is how `gpt-oss-20b` was answered by
  // CoreWeave on 2026-08-29, three weeks after CoreWeave was found injecting
  // zero-width characters into another model's output. Nothing had excluded it,
  // and nothing had preferred anyone else.
  //
  // Two properties make an explicit list safe to write unattended. It is
  // DERIVED, so a host that appears tomorrow joins on the next pass instead of
  // waiting for a release — a hand-written list would need a PR per provider.
  // And it is ORDERED by throughput, which is what lets a slow host stay in as
  // a genuine last resort: routing only reaches it once everything faster is
  // unavailable, and serving slowly then beats refusing.
  //
  // `order` is deliberately never set alongside `sort`: OpenRouter treats an
  // explicit order as the whole preference and silently drops the sort — and,
  // since 2026, an explicit order also disables its sticky routing, which is
  // what keeps a multi-step turn on one warm cache.
  //
  // `ignore` is CARRIED FORWARD rather than recomputed, because it is a
  // judgment where `only` is a measurement — see `poolJudgments` for the
  // ratchet that reasoning replaced.
  const vettedPool: ProviderPool | undefined =
    pool.endpoints.length > 0
      ? {
          only: [
            ...new Set(pool.endpoints.map((endpoint) => endpoint.provider)),
          ],
          sort: "throughput",
          ...(judgments.ignore === undefined
            ? {}
            : { ignore: judgments.ignore }),
        }
      : undefined;

  return {
    policy,
    judgments,
    pool,
    vettedPool,
    context: computeEffectiveContext(pool.endpoints),
    pricing: computePoolPricing(pool.endpoints),
  };
};
