/**
 * The pages suite's own pair of eyes. Not a test file.
 *
 * Every other assertion in `cases/pages.ts` reads the stored definition — it
 * can tell that a table exists and that its dataset returned rows, and it
 * cannot tell that the table is cut in half at 390px or that clicking a row
 * opens an empty panel. Those are the defects that actually reached production
 * (v3 audit, 2026-08-15), and the only way to see them is to render the page.
 *
 * So this module runs the REAL review pipeline on the page the turn stored:
 * `renderPage` (browser, two widths, plus the same page with every dataset
 * emptied) → `gatePageRender` (mechanical) → `evaluatePageDesign` (the critic).
 * Same code the `review` action runs, so the eval holds a page to exactly the
 * bar the builder was told to clear, and a change to the rubric moves both at
 * once instead of drifting apart.
 *
 * Two honest caveats, both worth stating rather than discovering later:
 *
 *   - The GATE is independent of the model and of the agent — nothing about it
 *     is circular, and it is the strongest signal here.
 *   - The SCORE is produced by the same critic the builder iterates against.
 *     For the pre-routing baseline that is not circular at all (those pages
 *     were never reviewed by anyone). Once the builder runs its own review
 *     loop, part of the gain is the loop working and part is convergence
 *     toward this critic's taste; read a rise as "it now clears its own bar",
 *     not as proof a human would like it more.
 *
 * Cost: one browser render (~5-9s) and one vision call (~2¢) per judged page,
 * shared by every assertion that looks at it. Only the cases that are about
 * the built page ask for it — the ten structural cases stay free.
 */

import type { PageDefinition } from "@fretik/shared/schemas/pages";
import { renderPage } from "@fretik/shared/services/pages/render/render-page";
import { evaluatePageDesign } from "../src/services/page-review/evaluate";
import { gatePageRender } from "../src/services/page-review/gate";
import { EMPTY_GATE, type PageJudgement } from "./page-judgement";
import type { EvalCaseContext } from "./types";

/**
 * One render per page per run, shared by every assertion that looks at it.
 * Without this the gate assertion and the score assertion would each drive a
 * browser and each pay for it, and — worse — could disagree about the same
 * page. Keyed by page id, which is unique per run; the pages are deleted at
 * cleanup, so nothing here outlives the case that filled it.
 */
const judged = new Map<string, Promise<PageJudgement>>();

const run = async (params: {
  pageId: string;
  pageName: string;
  definition: PageDefinition;
  ctx: EvalCaseContext;
}): Promise<PageJudgement> => {
  const compiled = params.definition.code.compiled;
  if (!compiled) {
    return {
      mounted: false,
      gate: EMPTY_GATE,
      critique: null,
      degraded: "the stored page has no compiled code — nothing to render",
    };
  }

  const render = await renderPage({
    compiled,
    definition: params.definition,
    teamId: params.ctx.teamId,
    userId: params.ctx.userId ?? null,
    pageName: params.pageName,
  });

  if (render.degraded !== undefined) {
    return {
      mounted: false,
      gate: EMPTY_GATE,
      critique: null,
      degraded: render.degraded,
    };
  }

  const gate = gatePageRender(render);
  if (!render.mounted) return { mounted: false, gate, critique: null };

  const critique = await evaluatePageDesign({
    pageName: params.pageName,
    brief: params.definition.brief,
    shots: render.shots,
    // The critic is told what the gate already caught so it spends its
    // attention on what only a reader can see.
    known: gate.blocking,
  });

  return critique.ok
    ? { mounted: true, gate, critique: critique.critique }
    : {
        mounted: true,
        gate,
        critique: null,
        critiqueUnavailable: critique.reason,
      };
};

/**
 * Render + judge the page, once per page per run.
 *
 * The critique always runs, even for a case that only asserts on the gate: it
 * costs about two cents, assertions execute concurrently so there is no
 * ordering to hang a "cheap mode" flag off without racing it, and a recorded
 * score on a case that does not gate on it is free data for the baseline.
 */
export const judgePage = (params: {
  pageId: string;
  pageName: string;
  definition: PageDefinition;
  ctx: EvalCaseContext;
}): Promise<PageJudgement> => {
  const existing = judged.get(params.pageId);
  if (existing) return existing;
  const promise = run(params);
  judged.set(params.pageId, promise);
  return promise;
};
