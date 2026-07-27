import { z } from "zod";

/**
 * Fetch live model metrics from the Artificial Analysis API (chantier C8).
 * `GET /api/v2/data/llms/models`, header `x-api-key`. Free tier is 1000 req/day
 * — callers MUST cache (see `get.ts`), never call per user request.
 *
 * Returns a lookup keyed by AA slug AND normalised name, so a profile matches
 * on its explicit `assessment.aaSlug` first and on its display name only as a
 * fallback. Resilient by design: a missing key, network error, or unparseable
 * body returns `null` — the caller then uses the committed fallback. Never
 * throws to the caller.
 *
 * # Which fields, and why these
 *
 * The v2 API exposes 10 top-level fields; we read every one that tells a team
 * something they cannot infer. Notably ABSENT from the API (available only in
 * the website payload): per-task output-token counts and hallucination rate.
 * Verbosity is therefore hand-curated per profile as
 * `assessment.verbosity` rather than scraped at runtime — a website layout
 * change must never be able to break a live request.
 *
 * `median_time_to_first_answer_token` is preferred over
 * `median_time_to_first_token_seconds`: the latter fires on the first REASONING
 * token, so a model that thinks for two minutes before speaking still scores
 * well on it. The former is what a user actually waits through.
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
      artificial_analysis_coding_index: z.number().nullish(),
      tau_banking: z.number().nullish(),
      ifbench: z.number().nullish(),
      lcr: z.number().nullish(),
    })
    .nullish(),
  median_output_tokens_per_second: z.number().nullish(),
  median_time_to_first_answer_token: z.number().nullish(),
});

const aaResponseSchema = z.object({
  data: z.array(aaModelSchema),
});

export interface AaMetric {
  intelligence: number | null;
  speed: number | null;
  timeToFirstAnswer: number | null;
  coding: number | null;
  toolUse: number | null;
  instructionFollowing: number | null;
  longContext: number | null;
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
        "[model-metrics] ARTIFICIAL_ANALYSIS_API_KEY unset — using fallback metrics",
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
        const evaluations = model.evaluations;
        const metric: AaMetric = {
          intelligence:
            evaluations?.artificial_analysis_intelligence_index ?? null,
          speed: model.median_output_tokens_per_second ?? null,
          timeToFirstAnswer: model.median_time_to_first_answer_token ?? null,
          coding: evaluations?.artificial_analysis_coding_index ?? null,
          toolUse: evaluations?.tau_banking ?? null,
          instructionFollowing: evaluations?.ifbench ?? null,
          longContext: evaluations?.lcr ?? null,
        };
        // Slug FIRST and unnormalised too: `assessment.aaSlug` is copied
        // verbatim from AA, so an exact hit is the common case.
        if (model.slug) {
          lookup.set(model.slug, metric);
          lookup.set(normalizeModelName(model.slug), metric);
        }
        if (model.name) lookup.set(normalizeModelName(model.name), metric);
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
