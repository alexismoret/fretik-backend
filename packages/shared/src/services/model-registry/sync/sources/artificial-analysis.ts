import { z } from "zod";
import type { AaMetrics } from "../../../../model-registry/types";
import { fetchJson } from "./wire";

/**
 * Artificial Analysis — the only source for a model's measured INTELLIGENCE.
 *
 * `GET /api/v2/data/llms/models`, header `x-api-key`, 1000 requests/day on the
 * free tier. 624 models on 2026-08-29. Neither catalogue API grades a model;
 * this one does, which is what makes `minIntelligenceIndex` a rule rather than
 * an opinion.
 *
 * SOFT BY CONSTRUCTION: no key, a network failure or a changed shape returns an
 * EMPTY map and never throws. Every `AaMetrics` field is optional everywhere
 * downstream and the intelligence rule is a soft failure, so a missing AA run
 * costs the sync nothing — while a throw here would fail a run that had already
 * gathered everything that matters.
 *
 * `median_time_to_first_answer_token` is kept ALONGSIDE
 * `median_time_to_first_token_seconds`, not instead of it: the latter fires on
 * the first REASONING token, so a model that thinks for 40 s before speaking
 * still scores 1.2 s on it (GLM-5.3-Flash: 1.18 vs 41.97, measured).
 *
 * Attribution to https://artificialanalysis.ai/ is REQUIRED wherever these
 * numbers are displayed.
 */

const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";

const modelSchema = z.object({
  name: z.string().nullish(),
  slug: z.string().nullish(),
  evaluations: z
    .object({
      artificial_analysis_intelligence_index: z.number().nullish(),
      artificial_analysis_coding_index: z.number().nullish(),
      artificial_analysis_math_index: z.number().nullish(),
      /**
       * Not published by v2 today (verified across all 624 entries
       * 2026-08-29). Declared so it lands the day AA adds it; nothing is
       * rescaled from `tau2` or `terminalbench` to stand in for it — an index
       * we invented would be indistinguishable from one they measured.
       */
      artificial_analysis_agentic_index: z.number().nullish(),
    })
    .nullish(),
  pricing: z
    .object({
      price_1m_input_tokens: z.number().nullish(),
      price_1m_output_tokens: z.number().nullish(),
    })
    .nullish(),
  median_output_tokens_per_second: z.number().nullish(),
  median_time_to_first_token_seconds: z.number().nullish(),
  median_time_to_first_answer_token: z.number().nullish(),
});

const responseSchema = z.object({ data: z.array(z.unknown()) });

/** Fold case and punctuation, so `GLM-5.3-Flash` and `glm-5-3-flash` meet. */
export const normalizeAaKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A finite number, or nothing. The EVALUATION fields null out what AA has not run. */
const num = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Same, but `0` is an ABSENCE.
 *
 * AA marks unmeasured data two different ways and the split is per family,
 * counted across all 624 entries on 2026-08-29:
 *
 * - evaluations use `null` — intelligence 13 null / 0 zero, coding 388 null /
 *   1 zero. A zero there is a real score and is kept.
 * - timings and prices are NEVER null and zero constantly — throughput and TTFT
 *   0 on 442 models, both prices 0 on 224. That is a sentinel, and storing it
 *   would publish "0 tokens/second" and "free" as measurements.
 */
const measured = (value: number | null | undefined): number | undefined => {
  const parsed = num(value);
  return parsed === 0 ? undefined : parsed;
};

/**
 * Absent fields are UNDEFINED, which disappears on the way into the jsonb
 * column — a field AA did not measure must not come back as a figure.
 */
const toMetrics = (
  raw: z.infer<typeof modelSchema>,
  fetchedAt: string,
): AaMetrics => {
  const evaluations = raw.evaluations;
  return {
    fetchedAt,
    slug: raw.slug ?? undefined,
    intelligenceIndex: num(evaluations?.artificial_analysis_intelligence_index),
    codingIndex: num(evaluations?.artificial_analysis_coding_index),
    agenticIndex: num(evaluations?.artificial_analysis_agentic_index),
    mathIndex: num(evaluations?.artificial_analysis_math_index),
    outputTokensPerSecond: measured(raw.median_output_tokens_per_second),
    timeToFirstTokenSeconds: measured(raw.median_time_to_first_token_seconds),
    timeToFirstAnswerTokenSeconds: measured(
      raw.median_time_to_first_answer_token,
    ),
    priceInputPerMTok: measured(raw.pricing?.price_1m_input_tokens),
    priceOutputPerMTok: measured(raw.pricing?.price_1m_output_tokens),
  };
};

/**
 * Every graded model, keyed by folded slug AND folded name, so a caller can
 * match on whichever spelling it holds — a profile key, a model id tail, a
 * display name. Empty map when the key is absent or anything fails.
 */
export const fetchArtificialAnalysis = async (): Promise<
  Map<string, AaMetrics>
> => {
  const lookup = new Map<string, AaMetrics>();
  const apiKey = Bun.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!apiKey) {
    console.warn(
      "[model-sync] ARTIFICIAL_ANALYSIS_API_KEY unset — grading without intelligence figures",
    );
    return lookup;
  }

  const result = await fetchJson(AA_MODELS_URL, {
    headers: { "x-api-key": apiKey },
  });
  if (!result.ok) {
    console.warn(
      `[model-sync] Artificial Analysis unavailable (${result.status.toString()}) — grading without intelligence figures`,
    );
    return lookup;
  }
  const parsed = responseSchema.safeParse(result.body);
  if (!parsed.success) {
    console.warn(
      "[model-sync] Artificial Analysis response shape changed — grading without intelligence figures",
    );
    return lookup;
  }

  const fetchedAt = new Date().toISOString();
  for (const raw of parsed.data.data) {
    const model = modelSchema.safeParse(raw);
    if (!model.success) continue;
    const metrics = toMetrics(model.data, fetchedAt);
    if (model.data.slug) lookup.set(normalizeAaKey(model.data.slug), metrics);
    // Name second so a slug collision never loses to a display name.
    if (model.data.name) {
      const key = normalizeAaKey(model.data.name);
      if (!lookup.has(key)) lookup.set(key, metrics);
    }
  }
  return lookup;
};
