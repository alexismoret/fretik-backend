import { z } from "zod";

/**
 * Fetch intelligence + speed from the Artificial Analysis API (chantier C8).
 * `GET /api/v2/data/llms/models`, header `x-api-key`. Free tier is 1000 req/day
 * — callers MUST cache (see `get.ts`), never call per user request.
 *
 * Returns a lookup keyed by NORMALISED model name AND slug so the registry can
 * match by either. Resilient by design: a missing key, network error, or
 * unparseable body returns `null` — the caller then uses the fallback. Never
 * throws to the caller.
 *
 * Attribution to https://artificialanalysis.ai/ is REQUIRED wherever these
 * values are shown (handled by the frontend).
 */

const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";

const aaModelSchema = z.object({
  name: z.string().nullish(),
  slug: z.string().nullish(),
  evaluations: z
    .object({
      artificial_analysis_intelligence_index: z.number().nullish(),
    })
    .nullish(),
  median_output_tokens_per_second: z.number().nullish(),
});

const aaResponseSchema = z.object({
  data: z.array(aaModelSchema),
});

export interface AaMetric {
  intelligence: number | null;
  speed: number | null;
}

/** Lowercase + alphanumeric only — robust matching across name/slug casing. */
export const normalizeModelName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

export type AaLookup = ReadonlyMap<string, AaMetric>;

export const fetchArtificialAnalysisMetrics =
  async (): Promise<AaLookup | null> => {
    const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    if (!apiKey) {
      console.warn(
        "[model-metrics] ARTIFICIAL_ANALYSIS_API_KEY unset — using fallback intelligence/speed",
      );
      return null;
    }

    try {
      const response = await fetch(AA_MODELS_URL, {
        headers: { "x-api-key": apiKey },
      });
      if (!response.ok) {
        console.warn(
          `[model-metrics] Artificial Analysis responded ${response.status} — using fallback`,
        );
        return null;
      }
      const parsed = aaResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        console.warn(
          "[model-metrics] Artificial Analysis response shape changed — using fallback",
        );
        return null;
      }

      const lookup = new Map<string, AaMetric>();
      for (const model of parsed.data.data) {
        const metric: AaMetric = {
          intelligence:
            model.evaluations?.artificial_analysis_intelligence_index ?? null,
          speed: model.median_output_tokens_per_second ?? null,
        };
        if (model.name) lookup.set(normalizeModelName(model.name), metric);
        if (model.slug) lookup.set(normalizeModelName(model.slug), metric);
      }
      return lookup;
    } catch (error) {
      console.warn(
        "[model-metrics] Artificial Analysis fetch failed — using fallback",
        error,
      );
      return null;
    }
  };
