import { redis } from "@fretik/shared/lib/redis";
import { median } from "@fretik/shared/model-registry/measures";
import type {
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { readAllLiveStateRows } from "@fretik/shared/services/model-registry/live";
import { listEffectiveProfiles } from "../../lib/model-registry/effective";
import { costLevelFromProfile, estimatedCostPerTurn } from "./cost-level";
import { FALLBACK_METRICS } from "./fallback";
import type { ModelMetrics, ModelMetricsSnapshot } from "./types";

/**
 * BUMP THIS whenever the snapshot's SHAPE or the set of profile keys changes.
 *
 * `get.ts` serves a cached snapshot untouched while it is under 24h old, and it
 * parses tolerantly so new axes read as absent rather than failing. Together
 * those mean a deploy that widens the snapshot silently serves the OLD one for a
 * day: v1 held the pre-2026-07-26 profile set, so after that deploy every
 * renamed or added model resolved to no metrics at all and the whole hub read
 * "Not measured". Changing the key makes the deploy invalidate its own cache —
 * the alternative is remembering to flush Redis by hand on every rollout.
 *
 * v5 (2026-08-30): this service stopped calling Artificial Analysis and
 * OpenRouter itself and now reads `model_live_state`, which the nightly sync
 * maintains. Two axes left with it (see `types.ts`).
 *
 * v6 (2026-08-31): `costRatio` added — cost as a multiple of the fleet median.
 */
export const MODEL_METRICS_CACHE_KEY = "model-metrics:v6";
const REFRESH_LOCK_KEY = "model-metrics:refreshing";
/**
 * Must comfortably EXCEED the worst-case refresh. It was 600 s when a refresh
 * meant an Artificial Analysis call plus up to 8 sequential OpenRouter probes
 * per profile; a refresh is now one indexed read of ~90 rows, so a minute is
 * already generous. Kept as a lock rather than dropped: replicas still race,
 * and a shorter TTL simply strands the lock for less time if a process dies.
 */
const REFRESH_LOCK_TTL_SECONDS = 60;

/**
 * Precision that survives the whole spread. The fleet runs from about a
 * thirtieth of typical to ninety times it, so a fixed number of decimals is
 * wrong at one end or the other: `0.0` erases a very cheap model entirely,
 * while `94.3` implies a precision an estimate does not have.
 */
const roundRatio = (ratio: number): number =>
  ratio < 1 ? Math.round(ratio * 100) / 100 : Math.round(ratio * 10) / 10;

/**
 * The endpoint a turn is most likely to land on.
 *
 * Routing is throughput-ordered (`sort: "throughput"` on every pool), so the
 * fastest reachable endpoint serves unless it is down — which makes the best
 * endpoint the honest one to describe, not the median. The policy's own
 * throughput floor grades on the same `best` aggregate, so the picker and the
 * publication rules cannot disagree about how fast a model is.
 *
 * Both figures come from the SAME endpoint rather than best-of-each: a speed
 * taken from one host and a latency from another describes a route that does
 * not exist.
 */
const servingEndpoint = (
  endpoints: readonly EndpointStat[],
): EndpointStat | undefined => {
  let best: EndpointStat | undefined;
  for (const endpoint of endpoints) {
    if (endpoint.throughputP50 === undefined) continue;
    if (
      best?.throughputP50 === undefined ||
      endpoint.throughputP50 > best.throughputP50
    )
      best = endpoint;
  }
  return best;
};

/**
 * Assemble the metrics snapshot from live state.
 *
 * Every figure now comes from one place — the row the nightly sync writes —
 * rather than from this service's own calls to Artificial Analysis and
 * OpenRouter. That collapse is the point:
 *
 *  - the AA free tier allows 100 requests/day across the whole account, and two
 *    independent clients paginating the same catalogue is how a budget gets
 *    spent twice for one answer;
 *  - the OpenRouter probe made up to 8 sequential requests per profile on every
 *    refresh to learn what `endpointStats` already records for the whole fleet;
 *  - a model with no TypeScript profile could never be matched by either client,
 *    so a promoted catalogue model would show a hub card with no metrics at all.
 *
 * Freshness is unchanged in practice: the snapshot was already served for up to
 * 24 h and the sync runs nightly.
 *
 * Pass an empty list to build the pure-fallback snapshot. `partial` is true when
 * any model resolved without live grades.
 */
export const buildModelMetricsSnapshot = (
  rows: readonly LiveModelState[],
): ModelMetricsSnapshot => {
  const byKey = new Map(rows.map((row) => [row.profileKey, row]));
  const metrics: Record<string, ModelMetrics> = {};
  let partial = false;

  // EFFECTIVE profiles, so a model promoted by a write gets its gauges on
  // the next refresh rather than on the next release. A promoted model has a
  // live row by construction, which is where every figure below comes from.
  const profiles = listEffectiveProfiles();

  /**
   * Every model's per-turn estimate, priced BEFORE the loop: `costRatio` is a
   * model's cost relative to its FLEET, so no model can be given one until every
   * sibling has been priced. A model with no price at all is left out of the
   * anchor rather than folded in as zero.
   *
   * The anchor is the MEDIAN and deliberately not the cheapest — see
   * `ModelMetrics.costRatio` for the measurement that settled it.
   */
  const perTurn = new Map(
    profiles.map((profile) => [
      profile.key,
      estimatedCostPerTurn(profile, byKey.get(profile.key)?.pricing),
    ]),
  );
  const typical = median([...perTurn.values()].filter((cost) => cost > 0));

  for (const profile of profiles) {
    const key = profile.key;
    const live = byKey.get(key);
    const turnCost = perTurn.get(key);
    const aa = live?.aaMetrics ?? null;
    const fallback = FALLBACK_METRICS[key];
    const serving = servingEndpoint(live?.endpointStats ?? []);
    if (aa === null) partial = true;

    metrics[key] = {
      intelligence: aa?.intelligenceIndex ?? fallback?.intelligence ?? null,
      // Measured on OUR routes. Artificial Analysis is no longer a fallback
      // here: it times whichever endpoint it chose, which for a pinned pool is
      // usually not one of ours, so it answered a different question.
      speed: serving?.throughputP50 ?? fallback?.speed ?? null,
      // The one axis only AA can produce: it fires on the first token of the
      // ANSWER, while every endpoint API times the first token of any kind and
      // cannot see where reasoning ends. Falls back to a captured figure — this
      // drives a headline gauge, where a blank column is worse than a stale
      // number.
      timeToFirstAnswer:
        aa?.timeToFirstAnswerTokenSeconds ??
        fallback?.timeToFirstAnswer ??
        null,
      // Detail-panel axes keep no fallback: secondary evidence, where an honest
      // blank costs the reader nothing.
      coding: aa?.codingIndex ?? null,
      toolUse: aa?.agenticIndex ?? null,
      // p50 time to first token on the endpoint above. Distinct from
      // `timeToFirstAnswer`: this fires on the first token of any kind, so a
      // reasoning model looks instant here while the user still waits.
      ttftSeconds:
        serving?.latencyP50Ms === undefined
          ? null
          : serving.latencyP50Ms / 1000,
      // The pool median the sync measured, falling back to the curated price.
      // The curated figure is hand-maintained with no automatic feed, so it is
      // the baseline, never the authority.
      costLevel: costLevelFromProfile(profile, live?.pricing),
      costRatio:
        typical === undefined || turnCost === undefined || turnCost <= 0
          ? null
          : roundRatio(turnCost / typical),
    };
  }

  return { metrics, fetchedAt: new Date().toISOString(), partial };
};

/**
 * Drop superseded snapshot keys.
 *
 * The snapshot is written WITHOUT a TTL on purpose — `get.ts` serves a stale
 * snapshot indefinitely while revalidating, which beats falling back to
 * committed values, and an expiry would throw that away. The cost is that every
 * `MODEL_METRICS_CACHE_KEY` bump stranded its predecessor forever: v1, v2 AND
 * v3 were all still resident when v4 shipped. So the sweep is explicit rather
 * than an expiry.
 *
 * Runs AFTER a successful write, so a failed refresh can never delete the
 * snapshot currently being served. `SCAN` rather than `KEYS` (which blocks the
 * server), and the `v[0-9]*` glob cannot match the `model-metrics:refreshing`
 * lock. Best-effort: a cleanup failure must never fail a refresh.
 */
const sweepSupersededSnapshots = async (): Promise<void> => {
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "model-metrics:v[0-9]*",
        "COUNT",
        100,
      );
      cursor = next;
      const superseded = keys.filter((key) => key !== MODEL_METRICS_CACHE_KEY);
      if (superseded.length > 0) {
        await redis.del(...superseded);
        console.log(
          `[model-metrics] swept superseded snapshot(s): ${superseded.join(", ")}`,
        );
      }
    } while (cursor !== "0");
  } catch (error) {
    console.warn("[model-metrics] failed to sweep superseded snapshots", error);
  }
};

/** Read live state and persist the snapshot to Redis. */
export const refreshModelMetrics = async (): Promise<ModelMetricsSnapshot> => {
  const rows = await readAllLiveStateRows();
  const snapshot = buildModelMetricsSnapshot(rows);
  await redis.set(MODEL_METRICS_CACHE_KEY, JSON.stringify(snapshot));
  await sweepSupersededSnapshots();
  return snapshot;
};

/**
 * Fire-and-forget refresh, guarded by a Redis lock so concurrent requests and
 * replicas don't stampede the database. Intentionally not awaited by callers —
 * the AI service is long-lived, so the detached promise completes.
 */
export const triggerBackgroundRefresh = async (): Promise<void> => {
  const acquired = await redis.set(
    REFRESH_LOCK_KEY,
    "1",
    "EX",
    REFRESH_LOCK_TTL_SECONDS,
    "NX",
  );
  if (!acquired) return;
  refreshModelMetrics()
    .catch((error) =>
      console.warn("[model-metrics] background refresh failed", error),
    )
    .finally(() => {
      void redis.del(REFRESH_LOCK_KEY);
    });
};
