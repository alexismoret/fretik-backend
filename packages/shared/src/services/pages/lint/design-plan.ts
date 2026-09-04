import type { PageBrief } from "../../../schemas/pages";
import type { PageLintFinding } from "./types";

/**
 * The design has to be decided before it is built, and written down where
 * something can hold the page to it.
 *
 * Every other commitment a page makes has a shape a machine can check —
 * datasets against the code that queries them, operations against the writes
 * that claim them, controls against the components that exist, colours against
 * the palette. Composition is 35% of the review score and was the one
 * commitment written as an intention: three prose fields, read by a critic
 * that could not disagree with them because nothing said what they had to
 * contain.
 *
 * What this refuses is not a bad plan — no lint can tell a good layout from a
 * bad one. It refuses the ABSENCE of one, which is a different and entirely
 * checkable thing, and which is what the default output is made of: a page
 * that never named its shape becomes a title, a row of four equal cards and a
 * table, because that is what a screen collapses to when nobody decided
 * otherwise.
 *
 * Four fields, each answering a question whose absence has a name in the
 * failure log:
 *
 * - `archetype` — what shape is this? Unnamed, it defaults.
 * - `hierarchy` — what leads? Unstated, everything ends up the same size.
 * - `containers` — where does depth open? Undecided, everything is a
 *   slideover, which is how the same overlay ended up on ten pages.
 * - `defaultsRejected` — what did you NOT do? The only field that cannot be
 *   written without having considered an alternative.
 *
 * Required on a page being created, advisory on one being repaired: a page
 * written before the plan existed must stay repairable without its author
 * being asked to redesign it first.
 */

const PAGE_JSON = "page.json";

const finding = (
  severity: "error" | "warning",
  message: string,
): PageLintFinding => ({
  path: PAGE_JSON,
  line: 0,
  rule: "design-plan",
  severity,
  message,
});

export const lintPageDesignPlan = (
  brief: PageBrief | undefined,
  options: { required: boolean },
): PageLintFinding[] => {
  const severity = options.required ? "error" : "warning";

  if (brief === undefined) {
    return [
      finding(
        severity,
        "page.json has no brief. Write it before the files: brief.product (job, audience, features) and brief.design (archetype, layout, hierarchy, containers, signature, defaultsRejected). The plan is the design decided — a page that starts at the first component becomes a title, four equal cards and a table.",
      ),
    ];
  }

  const design = brief.design;
  const missing: string[] = [];
  if (design.archetype === undefined || design.archetype.trim().length === 0) {
    missing.push(
      "archetype — name the shape (cockpit, workbench, ledger, feed, console, report, or one of your own)",
    );
  }
  if (design.hierarchy === undefined || design.hierarchy.trim().length === 0) {
    missing.push(
      "hierarchy — what leads, what supports, what recedes, in sizes rather than adjectives",
    );
  }
  if (
    design.containers === undefined ||
    design.containers.trim().length === 0
  ) {
    missing.push(
      "containers — where each piece of depth opens: in place, a popover, a panel, a view of its own, or a decision that must be finished",
    );
  }
  if (
    design.defaultsRejected === undefined ||
    design.defaultsRejected.length === 0
  ) {
    missing.push(
      "defaultsRejected — at least one generated default this page does NOT take, and what it does instead",
    );
  }

  if (missing.length === 0) return [];

  return [
    finding(
      severity,
      `brief.design is incomplete — ${missing.join("; ")}. Fill these in page.json before building: this is the plan the review scores the screen against.`,
    ),
  ];
};
