import db from "@fretik/shared/db";
import {
  eachPageFile,
  type PageDefinition,
} from "@fretik/shared/schemas/pages";
import {
  lintFindingsBlockingReview,
  lintPageDataContract,
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
 * Reviewing a page: the mechanical gate first, then the critic — and the loop
 * ends when the critic has nothing major left, not when it has spoken once.
 *
 * Two failures shaped this, in that order.
 *
 * It was three scored rounds with a best-of restore, and two production builds
 * measured what that bought: 6.6 → 6.8 → 7.0 on one, 6.3 → 6.6 → 6.1 on the
 * other, every step inside the critic's own run-to-run spread (identical bytes
 * scored 6.8 and 7.8 two minutes apart, 2026-08-23). What was noisy there was
 * RE-SCORING and CHOOSING: the same page judged again, and a winner picked
 * between readings that differed by less than the critic's own variance.
 *
 * Cutting to one critique fixed that and broke something else. On 2026-09-04 a
 * page scored 5.4, and shipped — because the second pass shipped on sight of an
 * existing critique, whatever it had said. The user was told the review had
 * "validated" it. A score that gates nothing is not information, it is
 * decoration on a verdict that was never in doubt.
 *
 * So: the critic looks after every change (identical bytes never get here — the
 * verdict cache answers first), the latest version is always the one that
 * stands, and shipping requires clearing the bar or running out of budget. No
 * re-scoring, no choosing, no free pass.
 *
 * What finds defects first is still the gate: measured, not judged — a dead
 * control, an overlay that opens empty, a native control, a control that writes
 * into rows the page cannot save. It runs before the critic every time.
 *
 * One service, two callers: the builder's `pageReview` and the parent's
 * `managePage { action: "review" }`. They share the budget and the caches,
 * because they are looking at the same page in the same turn.
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
export type PageReviewPhase = "gate" | "critique" | "elevate" | "final";

/**
 * Renders granted past `MAX_PAGE_REVIEWS`, gate-only.
 *
 * One, because one is what "never hand over code nobody looked at" costs. It is
 * not a bigger budget by another name: these passes never call the critic, so
 * the thing the budget was drawn around — paid re-scoring of a page the critic
 * cannot score consistently anyway — is capped exactly where it was.
 */
const FINAL_LOOKS = 1;

const FIX_BLOCKING =
  "Fix every line of `blocking` — those are measured, not opinions. Edit the file each one names, then review again. The critic looks once the gate passes.";
const APPLY_FINDINGS =
  "Apply each `finding` — they are what a user would hit — then review again. The next pass looks at what you changed, and the loop ends when nothing major is left or the budget runs out.";
const APPLY_ELEVATIONS =
  "Nothing is broken and the page is under the bar. `elevations` are the difference: apply the first one — both when they are cheap — then review again. This is the round that decides whether the page is competent or good, so spend it on the change that alters the screen, not on polish.";
const SHIP =
  "Nothing blocks this page: it ships as it stands. Hand back its url and pass on any `elevations` as what you would do next. Do NOT edit or review again — the verdict is final for this version.";

/**
 * How many renders an elevation round needs left to be worth starting.
 *
 * Two: one to build the change, one to see it. Starting with fewer spends the
 * budget on a page nobody will look at again, which is how a review ends on a
 * version that is different from the one it scored.
 */
const ELEVATION_MIN_BUDGET = 2;
/** At most two per round: the first changes the screen, the third is polish. */
const ELEVATIONS_PER_ROUND = 2;

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
  //
  // Past the cap there is still ONE look left, and it is the difference between
  // a budget that stops revision and a budget that stops verification. Reaching
  // this line at all means the page CHANGED since its last verdict — identical
  // bytes never get here, the cache answers above — so a flat refusal hands
  // over code nobody has seen. Measured 2026-09-04: a build fixed what a review
  // had found, had no budget left to look at the fix, and shipped saying so;
  // "this wasn't re-reviewed" is an honest sentence, not a reviewed page.
  //
  // What that last look does NOT get is the critic. The expensive half stays
  // capped exactly where it was, and this pass buys the cheap half the loop was
  // always allowed to repeat: does it still mount, does the gate still pass.
  const spent = await readPageReviewIterations(scope, page.id);
  const finalLook = spent >= MAX_PAGE_REVIEWS;
  if (spent >= MAX_PAGE_REVIEWS + FINAL_LOOKS) {
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
  // where a component belongs, and a control that writes into loaded rows the
  // page has no operation to save. Both lead the blocking list because they are
  // certain and because a screenshot cannot show either — the measured pages
  // carried ten native controls and one faked write between them, and the
  // critic scored all three without noticing any.
  const staticFindings = lintFindingsBlockingReview([
    ...lintPageProject(page.definition.code),
    ...lintPageDataContract(page.definition.code, {
      datasetIds: page.definition.datasets.map((dataset) => dataset.id),
      operationIds: page.definition.operations.map((operation) => operation.id),
    }),
  ]);

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

  // The last look ends here: the page mounts and the gate is clean, which is
  // everything this pass was granted to establish. Scoring it would reopen the
  // half the budget exists to bound, and a fresh score with nothing left to
  // spend on it is a number to feel bad about rather than one to act on.
  if (finalLook) {
    const previousCritique = await readPageCritique(scope, page.id);
    return {
      pageId: page.id,
      url: `/pages/${page.id}`,
      iteration: `${iteration.toString()}/${MAX_PAGE_REVIEWS.toString()}`,
      phase: "final",
      gate: "pass" as const,
      verdict: "ship" as const,
      ...(gate.observations.length > 0 ? { observed: gate.observations } : {}),
      ...(previousCritique?.elevations !== undefined
        ? { elevations: previousCritique.elevations }
        : {}),
      next: "The budget bought one last look and the page passed it: it mounts and the gate is clean. Ship. Say that this version was checked mechanically but not re-scored for design, and pass `elevations` on.",
    };
  }

  // The gate is clean, so the critic looks — again, if the page has changed
  // since it last did.
  //
  // Until 2026-09-04 a second pass here shipped ON SIGHT, whatever the critic
  // had said: one critique, findings applied once, ship. A build that measured
  // 5.4/10 was handed to the user as "validée, aucun élément bloquant". The
  // score was reported and gated nothing, which is worse than not reporting it
  // — it made the summary sound checked.
  //
  // Repeating the critique is NOT the three-round loop that was retired. That
  // one re-scored an unchanged page and picked the best round, which measured
  // the critic's variance and called it progress. This one re-scores only after
  // the builder changed something (identical bytes never reach here — the
  // verdict cache answers first), keeps the latest version always, and stops
  // the moment the critic has no major left. A page the critic clears at once
  // costs exactly what it cost before.
  const previous = await readPageCritique(scope, page.id);

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
  const cleared =
    critique.critique.score >= SHIP_SCORE && findings.length === 0;
  // Out of budget ships whatever it has. The alternative is a page held
  // hostage to a score it will never reach, and a builder with nothing left to
  // spend on reaching it — so it ships, and it says what it shipped.
  const exhausted = left <= 0;

  /**
   * Nothing is broken, and the page is not good enough.
   *
   * This state used to ship. The findings were empty, so the loop had nothing
   * to ask for and handed over a 6.1 — while the one channel that knew what
   * would make the page better was routed AWAY from the builder: `elevations`
   * came back with "these are not for you to build, hand them to the user".
   * The loop could correct a page and could not improve one, which is the
   * whole difference between a page that works and a page worth showing.
   *
   * So it spends a round here when it has one to spare. Bounded on purpose:
   * two elevations, and only while two renders remain, because an elevation
   * nobody looks at afterwards is a change nobody verified.
   */
  const elevating =
    !cleared &&
    !exhausted &&
    findings.length === 0 &&
    elevations.length > 0 &&
    left >= ELEVATION_MIN_BUDGET;

  // `elevating` already requires budget, so the two can never both be true.
  const ships = cleared || exhausted;

  await recordPageCritique(scope, page.id, {
    sourceHash,
    score: critique.critique.score,
    findings,
    elevations,
  });

  const phase: PageReviewPhase = ships
    ? "final"
    : elevating
      ? "elevate"
      : "critique";
  // An elevation round hands back the ones it is asking for, not all three:
  // what comes back is a work item, and three is a list to choose from.
  const handedBack = elevating
    ? elevations.slice(0, ELEVATIONS_PER_ROUND)
    : elevations;

  const result = {
    pageId: page.id,
    url: `/pages/${page.id}`,
    iteration: seen,
    phase,
    gate: "pass" as const,
    verdict: ships ? ("ship" as const) : ("revise" as const),
    score: critique.critique.score,
    scores: critique.critique.scores,
    summary: critique.critique.summary,
    ...(gate.observations.length > 0 ? { observed: gate.observations } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    ...(handedBack.length > 0 ? { elevations: handedBack } : {}),
    ...(previous !== null ? { previousScore: previous.score } : {}),
    next: cleared
      ? SHIP
      : exhausted
        ? `The review budget is spent and this is the version that ships, at ${critique.critique.score.toFixed(1)}/10 with ${findings.length.toString()} finding(s) open${elevations.length > 0 ? ` and ${elevations.length.toString()} elevation(s) unapplied` : ""}. Hand back the url and tell the user plainly what is still weak, naming them — not "perfectible".`
        : elevating
          ? APPLY_ELEVATIONS
          : APPLY_FINDINGS,
  };
  await recordPageReviewVerdict(scope, page.id, {
    sourceHash,
    shipped: ships,
    round: iteration,
    result,
  });
  return result;
};
