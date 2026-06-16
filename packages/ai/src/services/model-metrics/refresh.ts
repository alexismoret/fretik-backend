import { redis } from "@fretik/shared/lib/redis";
import { getModelDisplayName } from "../../lib/model-registry/display";
import { MODEL_PROFILES } from "../../lib/model-registry/profiles";
import { costLevelFromProfile } from "./cost-level";
import { FALLBACK_METRICS } from "./fallback";
import {
  type AaLookup,
  type AaMetric,
  fetchArtificialAnalysisMetrics,
  normalizeModelName,
} from "./fetch-artificial-analysis";
import type { ModelMetrics, ModelMetricsSnapshot } from "./types";

export const MODEL_METRICS_CACHE_KEY = "model-metrics:v1";
const REFRESH_LOCK_KEY = "model-metrics:refreshing";
const REFRESH_LOCK_TTL_SECONDS = 120;

/**
 * Registry key → Artificial Analysis model name, for the rare case where AA's
 * name differs from our `displayName`/key and normalised matching misses.
 * Empty by default — fill in as live AA data reveals mismatches.
 */
const AA_NAME_OVERRIDES: Record<string, string> = {};

const matchAa = (key: string, aa: AaLookup): AaMetric | undefined => {
  const candidates = [
    AA_NAME_OVERRIDES[key],
    getModelDisplayName(key),
    key,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
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
    const hit = aa ? matchAa(key, aa) : undefined;
    const fallback = FALLBACK_METRICS[key];
    if (!hit) partial = true;
    metrics[key] = {
      intelligence: hit?.intelligence ?? fallback?.intelligence ?? null,
      speed: hit?.speed ?? fallback?.speed ?? null,
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
