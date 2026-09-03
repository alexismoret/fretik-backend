import db from "@fretik/shared/db";
import {
  eachPageFile,
  type PageDefinition,
} from "@fretik/shared/schemas/pages";
import {
  lintFindingsBlockingReview,
  lintPageProject,
} from "@fretik/shared/services/pages/lint";
import { renderPage } from "@fretik/shared/services/pages/render/render-page";
import { writePageVersion } from "@fretik/shared/services/pages/versions";
import { renderProjectManifest } from "../page-project/manifest";
import { evaluatePageDesign, SHIP_SCORE } from "./evaluate";
import { gatePageRender } from "./gate";
import {
  bumpPageReviewIteration,
  hashPageCode,
  MAX_PAGE_REVIEWS,
  readPageCritique,
  readPageReviewIterations,
  readPageReviewVerdict,
  recordPageCritique,
  recordPageReviewVerdict,
} from "./page-session-store";

/**
 * Reviewing a page: the mechanical gate first, then ONE critique, then the gate
 * again — and that is the whole loop.
 *
 * It was three scored rounds with a best-of restore, and two production builds
 * measured what that bought: 6.6 → 6.8 → 7.0 on one, 6.3 → 6.6 → 6.1 on the
 * other, every step inside the critic's own run-to-run spread (identical bytes
 * scored 6.8 and 7.8 two minutes apart, 2026-08-23). Three critiques, three
 * page-scale fix rounds, and a page no better than after the first.
 *
 * What DOES find real defects is the gate: it is measured, not judged — a dead
 * control, an overlay that opens empty, content cut off at a width, a blank
 * empty state. So the gate runs first and repeats after every fix, while the
 * critic — the expensive, noisy half — looks once, at a page that already
 * passes it, and its findings are applied once.
 *
 * One service, two callers: the builder's `pageReview` and the parent's
 * `managePage { action: "review" }`. They share the budget, the verdict cache
 * and the single critique, because they are looking at the same page in the
 * same turn.
 */

/** What the caller is asking about. */
export interface PageReviewRequest {
  page: { id: string; name: string; definition: PageDefinition };
  teamId: string;
  userId: string | null;
  conversationId: string | undefined;
  /**
   * The run these reviews are counted against (a turn, a builder dispatch).
   * Undefined only where nothing identifies the run, in which case the budget
   * and the caches fall back to the page itself.
   */
  scope: string | undefined;
}

/** The phase a result belongs to, so the caller's next step is unambiguous. */
export type PageReviewPhase = "gate" | "critique" | "final";

const FIX_BLOCKING =
  "Fix every line of `blocking` — those are measured, not opinions. Edit the file each one names, then review again. The critic looks once the gate passes.";
const APPLY_ONCE =
  "Apply each `finding`, then review once more: that pass is gate-only and ends the loop. `elevations` are not for you to build — hand them to the user.";
const SHIP =
  "Nothing blocks this page: it ships as it stands. Hand back its url and pass on any `elevations` as what you would do next. Do NOT edit or review again — the verdict is final for this version.";

export const runPageReview = async (
  request: PageReviewRequest,
): Promise<Record<string, unknown>> => {
  const { page, scope } = request;
  const compiled = page.definition.code.compiled;
  if (!compiled) {
    return {
      pageId: page.id,
      review: "refused",
      reason: "this page has no compiled code — there is nothing to render.",
      next: "Build the page first; a review renders what is stored, and nothing is stored until a build is green.",
    };
  }

  // Identical bytes get the verdict already paid for. Re-scoring an unchanged
  // page measures the critic's variance, not the page — and it is what makes
  // "ship" final: a shipped page cannot be re-reviewed into a revise without
  // changing first.
  const sourceHash = hashPageCode(page.definition.code);
  const cached = await readPageReviewVerdict(scope, page.id);
  if (cached && cached.sourceHash === sourceHash) {
    return {
      ...cached.result,
      cached: true,
      next: cached.shipped
        ? "This exact version was already reviewed: the verdict stands — ship. Hand back the url; do not review again."
        : `This exact version was already reviewed and the findings stand. Apply them — a review re-scores only after the page changes.`,
    };
  }

  // Checked BEFORE the render, so a spent budget costs no browser, no
  // screenshots and no critic.
  const spent = await readPageReviewIterations(scope, page.id);
  if (spent >= MAX_PAGE_REVIEWS) {
    return {
      pageId: page.id,
      url: `/pages/${page.id}`,
      review: "refused",
      iteration: `${spent.toString()}/${MAX_PAGE_REVIEWS.toString()}`,
      next: "The review budget is spent. Hand the page to the user, and say what you would do next in the words of the last `elevations` you received rather than a vague 'still perfectible' — that is something they can decide about.",
    };
  }

  const render = await renderPage({
    compiled,
    definition: page.definition,
    teamId: request.teamId,
    userId: request.userId,
    pageName: page.name,
  });

  // No browser reachable is OUR failure, not the page's.
  if (render.degraded !== undefined) {
    return {
      pageId: page.id,
      review: "unavailable",
      reason: render.degraded,
      next: "Nobody can look at this page from here. Self-critique against the doctrine you already have, and say plainly that the page was not visually verified.",
    };
  }

  // What the CODE already proves, before anything renders: a native control
  // where a component belongs. It leads the blocking list because it is certain
  // and because a screenshot cannot show it — the two measured pages carried
  // ten of these between them and the critic scored both without noticing.
  const staticFindings = lintFindingsBlockingReview(
    lintPageProject(page.definition.code),
  );

  const gate = gatePageRender(render, {
    declaredDatasets: page.definition.datasets.length,
    declaredOperations: page.definition.operations.length,
    staticFindings,
  });

  // A page that never mounted was not judged, so the attempt consumes no
  // round: this is a crash-fix loop, not a review.
  if (!render.mounted) {
    return {
      pageId: page.id,
      url: `/pages/${page.id}`,
      gate: "fail",
      verdict: "unverified",
      ...(gate.blocking.length > 0 ? { blocking: gate.blocking } : {}),
      next: "The page never mounted, so no review round was spent. Read its runtime errors, fix the crash, and review again — nothing else about it can be judged until it renders.",
    };
  }

  const iteration = await bumpPageReviewIteration(scope, page.id);
  const left = MAX_PAGE_REVIEWS - iteration;
  const seen = `${iteration.toString()}/${MAX_PAGE_REVIEWS.toString()}`;

  if (!gate.pass) {
    const result = {
      pageId: page.id,
      url: `/pages/${page.id}`,
      iteration: seen,
      phase: "gate" as PageReviewPhase,
      gate: "fail" as const,
      verdict: "revise" as const,
      blocking: gate.blocking,
      ...(gate.observations.length > 0 ? { observed: gate.observations } : {}),
      next:
        left <= 0
          ? "This was the last render. Fix what you can of `blocking`, then hand the page over naming what you did not get to."
          : FIX_BLOCKING,
    };
    await recordPageReviewVerdict(scope, page.id, {
      sourceHash,
      shipped: false,
      round: iteration,
      result,
    });
    return result;
  }

  // The gate is clean. Has the critic already looked, in this run?
  const previous = await readPageCritique(scope, page.id);
  if (previous !== null) {
    const result = {
      pageId: page.id,
      url: `/pages/${page.id}`,
      iteration: seen,
      phase: "final" as PageReviewPhase,
      gate: "pass" as const,
      verdict: "ship" as const,
      score: previous.score,
      ...(gate.observations.length > 0 ? { observed: gate.observations } : {}),
      ...(previous.elevations.length > 0
        ? { elevations: previous.elevations }
        : {}),
      next: SHIP,
    };
    await recordPageReviewVerdict(scope, page.id, {
      sourceHash,
      shipped: true,
      round: iteration,
      result,
    });
    return result;
  }

  const critique = await evaluatePageDesign({
    pageName: page.name,
    brief: page.definition.brief,
    shots: render.shots,
    interactions: render.interactions,
    known: gate.blocking,
    // The file list, never the code: a finding that names the file to open is
    // one edit instead of a search.
    files: renderProjectManifest(
      Object.fromEntries(eachPageFile(page.definition.code)),
    ),
  });
  // A critic that failed (after its own retries) judged nothing, so nothing is
  // recorded — on 2026-08-23 one upstream rate limit silently ate a round.
  if (!critique.ok) {
    return {
      pageId: page.id,
      url: `/pages/${page.id}`,
      iteration: seen,
      gate: "pass" as const,
      verdict: "unverified",
      ...(gate.observations.length > 0 ? { observed: gate.observations } : {}),
      critiqueUnavailable: critique.reason,
      next: "The critic was unavailable. The mechanical gate passed, so the page is sound as far as anything measured it; review again if you have budget, otherwise hand it over saying the design was not critiqued.",
    };
  }

  // A record of what was judged, kept for history. Nothing restores from it
  // any more — the best-of-rounds swap it existed for was retired with the
  // three-round loop.
  await writePageVersion(db, {
    pageId: page.id,
    teamId: request.teamId,
    name: page.name,
    operation: "review-round",
    definition: page.definition,
    actor: {
      actor: "agent",
      userId: request.userId,
      conversationId: request.conversationId ?? null,
    },
    meta: { round: iteration, score: critique.critique.score },
  });

  // What the builder is asked to APPLY is the majors: something a user would
  // hit. Minors are polish, and a fix round spent on polish is a page-scale
  // write for a rounding error in a score the critic cannot reproduce anyway.
  const findings = critique.critique.findings.filter(
    (finding) => finding.severity === "major",
  );
  const elevations = critique.critique.elevations;
  const ships = critique.critique.score >= SHIP_SCORE && findings.length === 0;

  await recordPageCritique(scope, page.id, {
    sourceHash,
    score: critique.critique.score,
    findings,
    elevations,
  });

  const result = {
    pageId: page.id,
    url: `/pages/${page.id}`,
    iteration: seen,
    phase: (ships ? "final" : "critique") as PageReviewPhase,
    gate: "pass" as const,
    verdict: ships ? ("ship" as const) : ("revise" as const),
    score: critique.critique.score,
    scores: critique.critique.scores,
    summary: critique.critique.summary,
    ...(gate.observations.length > 0 ? { observed: gate.observations } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    ...(elevations.length > 0 ? { elevations } : {}),
    next: ships
      ? SHIP
      : left <= 0
        ? "This was the last render. Apply what you can, then hand the page over naming the findings you did not get to."
        : APPLY_ONCE,
  };
  await recordPageReviewVerdict(scope, page.id, {
    sourceHash,
    shipped: ships,
    round: iteration,
    result,
  });
  return result;
};
