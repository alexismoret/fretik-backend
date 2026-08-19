// Patches Zod with `.openapi()` — same load-bearing ordering as
// `cases/pages.ts`, and the blank line under it is what stops the import
// sorter from moving it below `@fretik`.
// oxlint-disable-next-line import/no-duplicates
import "@hono/zod-openapi";

import db from "@fretik/shared/db";
import { pages } from "@fretik/shared/db/schema";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { PageDefinitionSchema } from "@fretik/shared/schemas/pages";
import { renderPage } from "@fretik/shared/services/pages/render/render-page";
import { generateText, type ModelMessage } from "ai";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { telemetryFor } from "../src/lib/langfuse";
import { resolveModel } from "../src/lib/model-registry/resolve";

/**
 * Rank the pages a run produced, side by side. Not a test file, and not a gate.
 *
 * The review critic scores each page ALONE against a rubric, and that is why
 * everything lands on 7-8: without a point of comparison, "good" has no anchor,
 * and a model asked "is this good?" answers 8. Measured across four reviews —
 * broken pages scored 2.4 and 4.8, so it discriminates broken from working, and
 * every page that merely worked came back with four eights.
 *
 * Comparison is the instrument absolute scoring cannot be. Shown seven pages and
 * forced to order them, the same model produces sharp reasons, because "better
 * than that one, because…" is a question it can actually answer. That does not
 * fit the production `review` loop — there is only ever one page there, which is
 * what the `elevations` channel is for — but it fits an eval run exactly.
 *
 * What it is FOR, and the discipline that goes with it: this ranks and explains,
 * it never gates and never feeds a score. The moment a number computed here
 * decided anything, the builder would have something to optimise against and the
 * ranking would stop being an observation. Read it, then open the best and the
 * worst in a browser and look at them.
 */

const critic = resolveModel("page-review");

/** Ranking a longer list stops being a judgement and becomes a shuffle. */
const MAX_PAGES = 8;
const MAX_OUTPUT_TOKENS = 16_000;
const TIMEOUT_MS = 240_000;
const CRITIC_PROVIDER_OPTIONS = {
  openrouter: { reasoning: { effort: "medium" as const } },
};

const RankingSchema = z.object({
  ranking: z
    .array(
      z.object({
        // The bracketed number from the heading, never the name. Pages share
        // names — a run builds three called "Pipeline prospects" — and asking
        // for the name got back invented disambiguators ("Pipeline prospects
        // (3rd: CA estimé…)") that match nothing, so half the ranking came
        // back without a url to open.
        page: z.number().int().min(1),
        placement: z.number().int().min(1),
        why: z.string().max(400),
      }),
    )
    .max(MAX_PAGES),
  /** The transferable half: what the winner does that the others do not. */
  lesson: z.string().max(800),
  /** One thing the WHOLE set gets wrong — the systemic finding. */
  common_weakness: z.string().max(600),
});

export type PageRanking = z.infer<typeof RankingSchema>;

const INSTRUCTIONS = [
  "You are shown several pages built by the same agent for different requests, and your job is to order them from best to worst as pieces of design and product work.",
  "Comparison is the point. Do not score them in isolation and do not hedge: say which is better than which, and say what makes the difference. A tie is not an answer.",
  "Judge the screen as a working tool — what it answers on arrival, whether the layout encodes its subject or would fit any other dataset, whether values read the way a person reads them, whether there is anything to DO.",
  "The data is live and belongs to the team: a page with few rows or none is not worse for it. Never rank on how much data a page happens to show.",
  "Answer with a single JSON object and nothing else:",
  '{ "ranking": [ { "page": 1, "placement": 1, "why": "..." } ], "lesson": "what the best one does that the others do not, stated so it could be applied to any of them", "common_weakness": "the one thing every page here gets wrong" }',
  "`page` is the bracketed number in the heading above each capture, not its name — several of them share a name.",
  "`lesson` and `common_weakness` are what this exercise is for. The ordering is a device to get you to them.",
].join("\n");

interface RenderedPage {
  name: string;
  id: string;
  png: Uint8Array;
}

/**
 * The most recent pages of the eval team, rendered. Ordered oldest-first so the
 * list reads like the run that produced it, and capped: past eight images the
 * model spreads its attention and the reasons get vaguer.
 *
 * Pages with no `brief` are skipped, and that is not a detail. Some suite cases
 * SEED a page so the turn has something to edit or recover — hand-written SFCs,
 * deliberately crude. The first run of this tool ranked two of them last and
 * spent its reasons on `[object Object]` cells I wrote myself, which is a
 * critique of the fixture, not of the builder. The brief is the honest
 * discriminator: the pipeline writes one on every page it designs.
 */
const renderRecent = async (params: {
  teamId: string;
  userId: string | null;
  since: Date;
  limit: number;
}): Promise<{ rendered: RenderedPage[]; skipped: string[] }> => {
  const rows = await db
    .select({
      id: pages.id,
      name: pages.name,
      definition: pages.definition,
    })
    .from(pages)
    .where(
      and(eq(pages.teamId, params.teamId), gte(pages.createdAt, params.since)),
    )
    .orderBy(desc(pages.createdAt))
    // Fetched wide, then filtered, then capped — capping first would let a
    // couple of fixtures eat slots meant for built pages.
    .limit(params.limit * 3);

  const skipped: string[] = [];
  const candidates = rows.filter((row) => {
    const parsed = PageDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) return false;
    if (parsed.data.brief) return true;
    skipped.push(row.name);
    return false;
  });

  const rendered: RenderedPage[] = [];
  for (const row of candidates.slice(0, params.limit).reverse()) {
    const parsed = PageDefinitionSchema.safeParse(row.definition);
    const compiled = parsed.success ? parsed.data.code.compiled : undefined;
    if (!parsed.success || !compiled) continue;
    const render = await renderPage({
      compiled,
      definition: parsed.data,
      teamId: params.teamId,
      userId: params.userId,
      pageName: row.name,
    });
    // The arrival shot only. A ranking is about first impression and
    // composition; the per-page review already owns the narrow width, the
    // empty state and the bottom of the page.
    const shot = render.shots.find((s) => s.label === "desktop");
    if (shot) rendered.push({ id: row.id, name: row.name, png: shot.png });
  }
  return { rendered, skipped };
};

export const comparePages = async (params: {
  teamId: string;
  userId: string | null;
  since: Date;
  limit?: number;
}): Promise<
  | { ok: true; ranking: PageRanking; pages: RenderedPage[]; skipped: string[] }
  | { ok: false; reason: string }
> => {
  const { rendered, skipped } = await renderRecent({
    ...params,
    limit: Math.min(params.limit ?? MAX_PAGES, MAX_PAGES),
  });
  if (rendered.length < 2) {
    return {
      ok: false,
      reason: `only ${rendered.length.toString()} page(s) could be rendered — a comparison needs at least two`,
    };
  }

  const content: ModelMessage[] = [
    {
      role: "user",
      content: rendered.flatMap((page, index) => [
        {
          type: "text" as const,
          text: `## [${(index + 1).toString()}] ${page.name}`,
        },
        { type: "file" as const, data: page.png, mediaType: "image/png" },
      ]),
    },
  ];

  const { text } = await generateText({
    model: critic.model,
    instructions: INSTRUCTIONS,
    messages: content,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    telemetry: telemetryFor("page-review"),
    providerOptions: CRITIC_PROVIDER_OPTIONS,
  });

  const parsed = RankingSchema.safeParse(parseLlmJsonObject(text));
  return parsed.success
    ? { ok: true, ranking: parsed.data, pages: rendered, skipped }
    : { ok: false, reason: "the comparison did not come back readable" };
};

/**
 * CLI: `bun evals/page-compare.ts [hours]` — ranks the pages the eval team
 * built in the last N hours (default 3, which covers a run that just finished).
 * Prints the ordering plus each page's url, so the best and the worst can be
 * opened straight away.
 */
if (import.meta.main) {
  const hours = Number.parseFloat(process.argv[2] ?? "3");
  const teamId = process.env.EVAL_TEAM_ID;
  if (!teamId) throw new Error("Missing EVAL_TEAM_ID env");

  const result = await comparePages({
    teamId,
    userId: process.env.EVAL_USER_ID ?? null,
    since: new Date(Date.now() - hours * 60 * 60 * 1000),
  });

  if (!result.ok) {
    console.error(`✗ ${result.reason}`);
    process.exit(1);
  }

  console.error(`\n📊 ${result.pages.length.toString()} pages, ranked`);
  if (result.skipped.length > 0) {
    console.error(
      `   (skipped ${result.skipped.length.toString()} page(s) with no brief — seeded fixtures, not built: ${result.skipped.join(", ")})`,
    );
  }
  console.error("");
  for (const row of [...result.ranking.ranking].sort(
    (a, b) => a.placement - b.placement,
  )) {
    const entry = result.pages[row.page - 1];
    console.error(
      `${row.placement.toString()}. ${entry?.name ?? `page ${row.page.toString()}`}  ${entry ? `/pages/${entry.id}` : "(unmatched)"}\n   ${row.why}\n`,
    );
  }
  console.error(`\n🎯 What the best one does:\n   ${result.ranking.lesson}\n`);
  console.error(
    `⚠️  What they ALL get wrong:\n   ${result.ranking.common_weakness}\n`,
  );
  process.exit(0);
}
