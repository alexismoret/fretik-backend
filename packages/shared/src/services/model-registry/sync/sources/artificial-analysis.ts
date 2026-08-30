import { z } from "zod";
import type { AaMetrics } from "../../../../model-registry/types";
import { fetchJson } from "./wire";

/**
 * Artificial Analysis — the only source for a model's measured INTELLIGENCE.
 *
 * `GET /api/v2/language/models/free`, header `x-api-key`, 100 requests/day on
 * the free tier. 624 models over 4 pages on 2026-08-29. Neither catalogue API
 * grades a model; this one does, which is what makes `minIntelligenceIndex` a
 * rule rather than an opinion.
 *
 * MIGRATED off `/api/v2/data/llms/models` (2026-08-29): the legacy route answers
 * `410 Gone` after 2026-11-04. Our key is on the free tier — every `/language/*`
 * route without the `/free` suffix returns 403 "requires a Pro subscription"
 * ($417/month, declined). Coverage is identical: 624 models either way.
 *
 * WHAT THIS SOURCE IS FOR, AND ONLY FOR: the composite indices. It carries no
 * prices and no throughput, deliberately, because for both of those AA measures
 * a DIFFERENT MODEL THAN THE ONE WE RUN in two compounding ways:
 *
 *  - it aggregates over hosts our pool never routes to. 24 of the 624 quote a
 *    price of 0 (`gemma-3-4b`, `phi-4-multimodal`, `devstral-2`) while our own
 *    pool prices `mistral-devstral-2` at $0.800 blended;
 *  - it publishes ONE RECORD PER EFFORT LEVEL, so even a correct match returns
 *    a variant's figures (GPT-5.6 Luna spans 33.9 to 51.2 across its ladder).
 *
 * The pool median (`computePoolPricing`) and the per-route endpoint stats are
 * measured on the routes we actually reach, and they are the only prices and
 * speeds anything reads. The indices have no such alternative — nobody else
 * grades a model — which is exactly why this source exists.
 *
 * `median_time_to_first_answer_token_seconds` is the one timing kept, because
 * it too has no alternative: it fires on the first token of the ANSWER, while
 * every endpoint API measures the first token of ANY kind, so a model that
 * thinks for 40 s before speaking still scores ~1.2 s there (GLM-5.3-Flash:
 * 1.18 vs 41.97, measured).
 *
 * SOFT BY CONSTRUCTION: no key, a network failure or a changed shape returns an
 * EMPTY map and never throws. Every `AaMetrics` field is optional everywhere
 * downstream and the intelligence rule is a soft failure, so a missing AA run
 * costs the sync nothing — while a throw here would fail a run that had already
 * gathered everything that matters.
 *
 * Attribution to https://artificialanalysis.ai/ is REQUIRED wherever these
 * numbers are displayed.
 */

const AA_MODELS_URL =
  "https://artificialanalysis.ai/api/v2/language/models/free";

/**
 * A stop, not a page budget: the loop already ends on `has_more`, and the real
 * catalogue is 4 pages. This bounds the damage if a future response keeps
 * claiming there is more — at 100 requests/day, a runaway loop would burn the
 * quota for the rest of the day and silently degrade every later run.
 */
const MAX_PAGES = 10;

const modelSchema = z.object({
  name: z.string().nullish(),
  slug: z.string().nullish(),
  /** `YYYY-MM-DD`, on all 624 entries. Fallback for models the catalogue omits. */
  release_date: z.string().nullish(),
  evaluations: z
    .object({
      artificial_analysis_intelligence_index: z.number().nullish(),
      artificial_analysis_coding_index: z.number().nullish(),
      /**
       * Published for the first time by this route — 178 of 624 graded. The
       * legacy route declared it and populated it for none of our models.
       */
      artificial_analysis_agentic_index: z.number().nullish(),
    })
    .nullish(),
  /** Timings moved UNDER `performance` in v2; they were top-level in legacy. */
  performance: z
    .object({
      median_time_to_first_answer_token_seconds: z.number().nullish(),
    })
    .nullish(),
});

const responseSchema = z.object({
  data: z.array(z.unknown()),
  /**
   * Which index the grades are on. Stored because a threshold only means
   * something within one version: AA renumbers the whole fleet on a major bump,
   * so an `intelligence >= 45` floor would quietly start selecting a different
   * set of models. 4.1 on 2026-08-29.
   */
  intelligence_index_version: z.union([z.number(), z.string()]).nullish(),
  pagination: z
    .object({
      total_pages: z.number().nullish(),
      has_more: z.boolean().nullish(),
    })
    .nullish(),
});

/** Fold case and punctuation, so `GLM-5.3-Flash` and `glm-5-3-flash` meet. */
export const normalizeAaKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The AA record for one model: the curated slug first, then the profile key,
 * then each model id and its tail.
 *
 * The ORDER is the whole point, and it lives here rather than at the call site
 * because it is a property of this source. AA publishes ONE RECORD PER EFFORT
 * LEVEL, so every fallback below can only return whichever rung happens to
 * share our spelling — `gpt-5-6-luna` matches the family's base record while a
 * profile may run `-xhigh`, and that ladder spans 33.9 to 51.2 on the
 * intelligence index. A wrong rung is worse than no match at all: it grades, it
 * looks entirely plausible, and it feeds a tier floor. `aaSlug` is how curation
 * settles that, so a fallback running before it would make the field decorative.
 */
export const matchAaRecord = (
  lookup: ReadonlyMap<string, AaMetrics>,
  target: {
    aaSlug?: string | null;
    profileKey: string;
    modelIds: readonly string[];
  },
): AaMetrics | null => {
  const keys = [
    ...(target.aaSlug == null ? [] : [target.aaSlug]),
    target.profileKey,
    ...target.modelIds.flatMap((id) => [id, id.split("/").at(-1) ?? id]),
  ];
  for (const key of keys) {
    const hit = lookup.get(normalizeAaKey(key));
    if (hit !== undefined) return hit;
  }
  return null;
};

/**
 * A finite number, or nothing.
 *
 * `0` is KEPT on the indices: it is a real score there, and this route marks
 * what it has not run with `null` (intelligence 13 null / 0 zero, coding 388
 * null / 1 zero, counted 2026-08-29).
 */
const num = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Same, but `0` is an ABSENCE. Applied to the one TIMING we keep.
 *
 * This is now a guard rather than a workaround, and the distinction matters if
 * anyone revisits it. The legacy route never used null and leaned on `0` as its
 * sentinel — throughput and TTFT read 0 on 442 of 624 models. This route
 * reports `null` instead (298 unmeasured, and ZERO zeros across every timing
 * field). The guard stays because the failure it prevents is one-sided: a `0`
 * would publish as *instant* on a latency gauge, while dropping a genuine zero
 * costs nothing — no model answers in zero seconds.
 */
const measuredTiming = (
  value: number | null | undefined,
): number | undefined => {
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
  indexVersion: string | undefined,
): AaMetrics => ({
  fetchedAt,
  slug: raw.slug ?? undefined,
  indexVersion,
  releaseDate: raw.release_date ?? undefined,
  intelligenceIndex: num(
    raw.evaluations?.artificial_analysis_intelligence_index,
  ),
  codingIndex: num(raw.evaluations?.artificial_analysis_coding_index),
  agenticIndex: num(raw.evaluations?.artificial_analysis_agentic_index),
  timeToFirstAnswerTokenSeconds: measuredTiming(
    raw.performance?.median_time_to_first_answer_token_seconds,
  ),
});

/** One page, parsed. `undefined` when the page could not be read at all. */
const fetchPage = async (
  apiKey: string,
  page: number,
): Promise<z.infer<typeof responseSchema> | undefined> => {
  const result = await fetchJson(`${AA_MODELS_URL}?page=${page.toString()}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!result.ok) {
    console.warn(
      `[model-sync] Artificial Analysis page ${page.toString()} unavailable (${result.status.toString()})`,
    );
    return undefined;
  }
  const parsed = responseSchema.safeParse(result.body);
  if (!parsed.success) {
    console.warn(
      `[model-sync] Artificial Analysis page ${page.toString()} shape changed`,
    );
    return undefined;
  }
  return parsed.data;
};

/**
 * Every graded model, keyed by folded slug AND folded name, so a caller can
 * match on whichever spelling it holds — a profile key, a model id tail, a
 * display name. Empty map when the key is absent or the FIRST page fails.
 *
 * A LATER page failing yields a PARTIAL map rather than nothing, and that is
 * safe by construction: the sync writes `aaMetrics` only where the lookup
 * returns a hit, so a model whose page went missing keeps the grades it already
 * had rather than being erased. Throwing away three quarters of the fleet's
 * grades over one flaky page would be the worse outcome.
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

  const fetchedAt = new Date().toISOString();
  let indexVersion: string | undefined;
  let pagesRead = 0;
  let expectedPages: number | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await fetchPage(apiKey, page);
    if (body === undefined) break;
    pagesRead += 1;
    if (indexVersion === undefined && body.intelligence_index_version != null)
      indexVersion = String(body.intelligence_index_version);
    expectedPages = body.pagination?.total_pages ?? expectedPages;

    for (const raw of body.data) {
      const model = modelSchema.safeParse(raw);
      if (!model.success) continue;
      const metrics = toMetrics(model.data, fetchedAt, indexVersion);
      if (model.data.slug) lookup.set(normalizeAaKey(model.data.slug), metrics);
      // Name second so a slug collision never loses to a display name.
      if (model.data.name) {
        const key = normalizeAaKey(model.data.name);
        if (!lookup.has(key)) lookup.set(key, metrics);
      }
    }

    if (body.pagination?.has_more !== true) break;
  }

  if (pagesRead === 0) {
    console.warn(
      "[model-sync] Artificial Analysis unavailable — grading without intelligence figures",
    );
    return lookup;
  }
  if (expectedPages !== undefined && pagesRead < expectedPages) {
    console.warn(
      `[model-sync] Artificial Analysis returned ${pagesRead.toString()} of ${expectedPages.toString()} pages — graded ${lookup.size.toString()} model(s); models on the missing pages keep their previous grades`,
    );
  }
  return lookup;
};
