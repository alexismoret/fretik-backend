import { redis } from "@fretik/shared/lib/redis";
import { z } from "zod";
import {
  buildModelMetricsSnapshot,
  MODEL_METRICS_CACHE_KEY,
  triggerBackgroundRefresh,
} from "./refresh";
import type { ModelMetricsSnapshot } from "./types";

/**
 * Read the model-metrics snapshot with stale-while-revalidate (chantier C8):
 * - fresh (<24h)  → return cached;
 * - stale (>24h)  → return cached NOW + refresh in the background;
 * - cold / corrupt → return the fallback snapshot NOW + refresh in background.
 *
 * Never blocks on the network, so the picker endpoint is always fast and the
 * UI always renders (fallback intelligence/speed + real catalog cost).
 */

const FRESH_MS = 24 * 60 * 60 * 1000;

const snapshotSchema = z.object({
  metrics: z.record(
    z.string(),
    z.object({
      intelligence: z.number().nullable(),
      speed: z.number().nullable(),
      costLevel: z.number(),
    }),
  ),
  fetchedAt: z.string(),
  partial: z.boolean(),
});

export const getModelMetrics = async (): Promise<ModelMetricsSnapshot> => {
  const cached = await redis.get(MODEL_METRICS_CACHE_KEY);
  if (cached) {
    const parsed = snapshotSchema.safeParse(JSON.parse(cached));
    if (parsed.success) {
      const ageMs = Date.now() - new Date(parsed.data.fetchedAt).getTime();
      if (ageMs > FRESH_MS) void triggerBackgroundRefresh();
      return parsed.data;
    }
  }
  // Cold or corrupt cache: serve fallback immediately, refresh in background.
  void triggerBackgroundRefresh();
  return buildModelMetricsSnapshot(null);
};
