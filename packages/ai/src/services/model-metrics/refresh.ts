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
export const MODEL_METRICS_CACHE_KEY = "model-metrics:v3";
const REFRESH_LOCK_KEY = "model-metrics:refreshing";
const REFRESH_LOCK_TTL_SECONDS = 120;

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
 * Assemble the metrics snapshot from an AA lookup (or `null` to use fallback
 * everywhere). Intelligence/speed prefer live AA, then the curated fallback;
 * `costLevel` is ALWAYS the real catalog-derived value. `partial` is true when
 * AA was unavailable or any model went unmatched.
 */
export const buildModelMetricsSnapshot = (
  aa: AaLookup | null,
): ModelMetricsSnapshot => {
  const metrics: Record<string, ModelMetrics> = {};
  let partial = aa === null;

  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    const hit = aa ? matchAa(profile, aa) : undefined;
    const fallback = FALLBACK_METRICS[key];
    if (!hit) partial = true;
    metrics[key] = {
      intelligence: hit?.intelligence ?? fallback?.intelligence ?? null,
      // Same 0-means-absent rule as `timeToFirstAnswer` below — AA returns 0 on
      // BOTH throughput axes for a model it has scored but not yet timed
      // (deepseek-v4-flash 0731 on 2026-08-02), and `??` would let that 0
      // through as a real measurement.
      speed:
        (hit?.speed ?? 0) > 0
          ? (hit?.speed ?? null)
          : (fallback?.speed ?? null),
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
      costLevel: costLevelFromProfile(profile),
    };
  }

  return { metrics, fetchedAt: new Date().toISOString(), partial };
};

/** Fetch live metrics and persist the snapshot to Redis. */
export const refreshModelMetrics = async (): Promise<ModelMetricsSnapshot> => {
  const aa = await fetchArtificialAnalysisMetrics();
  const snapshot = buildModelMetricsSnapshot(aa);
  await redis.set(MODEL_METRICS_CACHE_KEY, JSON.stringify(snapshot));
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
