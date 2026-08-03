import { redis } from "@fretik/shared/lib/redis";
import { getModelDisplayName } from "../../lib/model-registry/display";
import { MODEL_PROFILES } from "../../lib/model-registry/profiles";
import type { ModelProfile } from "../../lib/model-registry/types";
import { costLevelFromProfile } from "./cost-level";
import { FALLBACK_METRICS } from "./fallback";
import {
  type AaLookup,
  type AaMetric,
  fetchArtificialAnalysisMetrics,
  normalizeModelName,
} from "./fetch-artificial-analysis";
import {
  fetchOpenRouterRouting,
  type RoutingLookup,
} from "./fetch-openrouter-routing";
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
 */
export const MODEL_METRICS_CACHE_KEY = "model-metrics:v4";
const REFRESH_LOCK_KEY = "model-metrics:refreshing";
/**
 * Must comfortably EXCEED the worst-case refresh. It was 120s when the refresh
 * was a single Artificial Analysis call; adding the OpenRouter routing probes
 * (up to 8 sequential per profile, 22 profiles) pushed a full run past two
 * minutes, so the lock would expire mid-flight and let a second refresh
 * stampede the very APIs it exists to protect. 10 minutes leaves headroom for a
 * slow upstream without stranding the lock for long if a process dies.
 */
const REFRESH_LOCK_TTL_SECONDS = 600;

/**
 * Match a profile to its Artificial Analysis record.
 *
 * `assessment.aaSlug` is the authoritative path and should be set on every
 * profile AA covers. Display-name matching survives only as a fallback for
 * profiles without a slug — it is genuinely unreliable for two reasons:
 * a profile absent from `MODEL_DISPLAY_NAME` silently matched nothing (which is
 * what happened to `gemini-3.5-flash-lite`), and AA publishes ONE RECORD PER
 * EFFORT LEVEL, so a name match returns whichever variant happens to share our
 * label rather than the level we actually run. GPT-5.6 Luna alone spans 33.3 to
 * 51.2 intelligence across its five levels.
 */
const matchAa = (profile: ModelProfile, aa: AaLookup): AaMetric | undefined => {
  const slug = profile.assessment.aaSlug;
  if (slug !== undefined) {
    const exact = aa.get(slug) ?? aa.get(normalizeModelName(slug));
    if (exact) return exact;
    console.warn(
      `[model-metrics] aaSlug "${slug}" (profile ${profile.key}) not found in the Artificial Analysis response — check for a rename`,
    );
  }
  for (const candidate of [getModelDisplayName(profile.key), profile.key]) {
    const hit = aa.get(normalizeModelName(candidate));
    if (hit) return hit;
  }
  return undefined;
};

/**
 * Assemble the metrics snapshot. Intelligence prefers live AA then the curated
 * fallback; `speed` prefers the throughput OpenRouter measured on the upstream
 * we actually route to, then AA, then the fallback; `costLevel` is derived from
 * the live routed-endpoint price when one resolved, else the curated
 * `assessment.pricing`. `partial` is true when a source was unavailable or any
 * model went unmatched.
 *
 * Pass `null` / an empty map to build the pure-fallback snapshot.
 */
export const buildModelMetricsSnapshot = (
  aa: AaLookup | null,
  routing: RoutingLookup = new Map(),
): ModelMetricsSnapshot => {
  const metrics: Record<string, ModelMetrics> = {};
  let partial = aa === null;

  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    const hit = aa ? matchAa(profile, aa) : undefined;
    const fallback = FALLBACK_METRICS[key];
    const routed = routing.get(key);
    if (!hit) partial = true;
    metrics[key] = {
      intelligence: hit?.intelligence ?? fallback?.intelligence ?? null,
      // OpenRouter FIRST: its figure is the p50 of the specific upstream this
      // profile routes to, while AA measures whichever route it chose — which
      // for a pinned profile is usually not ours. Same 0-means-absent rule as
      // `timeToFirstAnswer` below: AA returns 0 on BOTH throughput axes for a
      // model it has scored but not yet timed (deepseek-v4-flash 0731 on
      // 2026-08-02), and `??` would let that 0 through as a real measurement.
      speed:
        routed?.throughputTps ??
        ((hit?.speed ?? 0) > 0
          ? (hit?.speed ?? null)
          : (fallback?.speed ?? null)),
      // Falls back like intelligence/speed: this drives a headline gauge, so a
      // blank column is worse than a figure captured a few weeks ago. AA reports
      // 0 (not null) when it has no throughput data for a model, which would
      // read as "instant" — treat 0 as absent.
      timeToFirstAnswer:
        (hit?.timeToFirstAnswer ?? 0) > 0
          ? (hit?.timeToFirstAnswer ?? null)
          : (fallback?.timeToFirstAnswer ?? null),
      // The detail-panel axes below keep no fallback rows: they are secondary
      // evidence, where an honest blank costs the reader nothing.
      coding: hit?.coding ?? null,
      toolUse: hit?.toolUse ?? null,
      instructionFollowing: hit?.instructionFollowing ?? null,
      longContext: hit?.longContext ?? null,
      // p50 time to first token on OUR upstream. Distinct from
      // `timeToFirstAnswer`: this fires on the first token of any kind, so a
      // reasoning model looks instant here while the user still waits.
      ttftSeconds: routed?.ttftSeconds ?? null,
      costLevel: costLevelFromProfile(profile, routed?.pricing),
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

/** Fetch live metrics and persist the snapshot to Redis. */
export const refreshModelMetrics = async (): Promise<ModelMetricsSnapshot> => {
  const [aa, routing] = await Promise.all([
    fetchArtificialAnalysisMetrics(),
    fetchOpenRouterRouting(),
  ]);
  const snapshot = buildModelMetricsSnapshot(aa, routing);
  await redis.set(MODEL_METRICS_CACHE_KEY, JSON.stringify(snapshot));
  await sweepSupersededSnapshots();
  return snapshot;
};

/**
 * Fire-and-forget refresh, guarded by a Redis lock so concurrent requests /
 * replicas don't stampede the AA + OpenRouter APIs. Intentionally not awaited
 * by callers — the AI service is long-lived, so the detached promise completes.
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
