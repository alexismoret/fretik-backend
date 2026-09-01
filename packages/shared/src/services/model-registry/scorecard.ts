import {
  DEFAULT_CANDIDATE_POLICY,
  evaluatePolicy,
} from "../../model-registry/policy";
import type {
  AaMetrics,
  EndpointStat,
  LiveModelState,
  PolicyReport,
} from "../../model-registry/types";
import { activeQuarantines } from "./breaker";
import { buildAllowedPool } from "./sync/compute";
import { fetchGatewayEndpoints } from "./sync/sources/gateway-endpoints";

/**
 * The promotion aid's inputs, decided once for every surface that asks.
 *
 * Two things here are decisions rather than formatting, which is why they are
 * not left in each caller: WHICH policy a scorecard grades against, and what to
 * do when the sync has never measured the row. Both were written out in the CLI
 * and would have been rewritten, slightly differently, in the handler.
 *
 * The policy is `DEFAULT_CANDIDATE_POLICY` — the strict DISCOVERY one, not the
 * looser bar a published model is held to. Deliberate: this screen is read when
 * deciding to START running something, while the looser policy answers "is it
 * still serviceable", a different question asked at a different time.
 */

/**
 * Where the endpoint list came from.
 *
 * A discriminant rather than a sentence, because a surface has to BRANCH on it:
 * `stored` is a measurement, `live` is a snapshot taken just now, and the two
 * failures mean the verdict below is computed from nothing and must be shown as
 * such rather than as a model that failed every rule.
 */
export type EndpointSource =
  "stored" | "live" | "no-gateway-id" | "fetch-failed";

export interface ScorecardEndpoints {
  endpoints: EndpointStat[];
  source: EndpointSource;
  /** Present only on `fetch-failed`; the upstream's own message. */
  error?: string;
}

/**
 * Endpoints for a scorecard, preferring what the sync stored.
 *
 * The stored list is MERGED across both catalogue sources (it is the only place
 * `quantization` ever appears), so a live re-fetch is a fallback for a row the
 * sync has not reached yet — a freshly added candidate above all — and not an
 * improvement on it.
 *
 * That fallback is also the slow path, and it is slow exactly when someone is
 * waiting: a candidate added a minute ago is precisely the row with no stored
 * stats. Callers serving a request pass a short `timeoutMs` and render
 * `fetch-failed` honestly instead of holding the connection.
 */
export const scorecardEndpoints = async (
  state: LiveModelState,
  options?: { timeoutMs?: number },
): Promise<ScorecardEndpoints> => {
  if (state.endpointStats.length > 0) {
    return { endpoints: state.endpointStats, source: "stored" };
  }
  const gatewayId = state.modelIds.gateway;
  if (gatewayId === undefined) {
    return { endpoints: [], source: "no-gateway-id" };
  }
  try {
    return {
      endpoints: await fetchGatewayEndpoints(
        gatewayId,
        options?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs },
      ),
      source: "live",
    };
  } catch (err: unknown) {
    return {
      endpoints: [],
      source: "fetch-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * The endpoints the discovery policy allows, and what it dropped.
 *
 * Graded against the discovery policy's OWN filters so the list on screen is
 * the one the verdict was computed from, rather than a wider set that would
 * make the verdict look arbitrary.
 */
export const scorecardPool = (
  state: LiveModelState,
  endpoints: readonly EndpointStat[],
  now: Date,
): {
  endpoints: EndpointStat[];
  excluded: { provider: string; reason: string }[];
} =>
  buildAllowedPool({
    ...(state.providerPool[state.transport] === undefined
      ? {}
      : { declaredPool: state.providerPool[state.transport] }),
    poolWidened: state.poolWidened,
    quarantined: activeQuarantines(state, now)
      .filter((entry) => entry.transport === state.transport)
      .map((entry) => entry.provider),
    endpoints: [...endpoints],
    requireTools: DEFAULT_CANDIDATE_POLICY.toolCallingRequired,
    requireZdr: DEFAULT_CANDIDATE_POLICY.zdrRequired,
    ...(DEFAULT_CANDIDATE_POLICY.quantizationFloor === undefined
      ? {}
      : { quantizationFloor: DEFAULT_CANDIDATE_POLICY.quantizationFloor }),
  });

/** The scorecard verdict. Pure — a preflight can compute it without writing. */
export const evaluateScorecardPolicy = (input: {
  endpoints: readonly EndpointStat[];
  excluded: readonly { provider: string; reason: string }[];
  aa: AaMetrics | null;
  now: Date;
}): PolicyReport =>
  evaluatePolicy(
    DEFAULT_CANDIDATE_POLICY,
    {
      endpoints: [...input.endpoints],
      excludedProviders: [...input.excluded],
      aa: input.aa,
      requiresTools: true,
    },
    input.now,
  );
