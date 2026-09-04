import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import type { PageBrief } from "../../src/schemas/pages";
import { PageBriefSchema } from "../../src/schemas/pages";
import { lintPageDesignPlan } from "../../src/services/pages/lint/design-plan";

/**
 * The plan is the one design commitment a machine can hold a page to, and this
 * pins the only thing it can honestly check: that the plan was made.
 *
 * No lint can tell a good layout from a bad one. What it can tell is a page
 * that never named its shape, never said what leads, never decided where depth
 * opens and never rejected a default — which is precisely the state a screen
 * has to be in to come out as a title, four equal cards and a table.
 */

const plan = (overrides: Partial<PageBrief["design"]> = {}): PageBrief => ({
  product: {
    job: "Work the week's deals without leaving Fretik.",
    audience: "The two people who chase them, mid-call.",
    features: ["filter by stage", "open one", "move it"],
  },
  design: {
    archetype: "workbench",
    layout: "list at 5 columns, detail at 7, figures banded above",
    hierarchy: "the overdue figure leads at text-5xl; the list is secondary",
    containers: "detail in a panel, quick status inline, delete behind a modal",
    signature: "the overdue figure wears the error hue and its own bar",
    defaultsRejected: ["four equal KPI cards → one figure at 3x and two small"],
    alternative: "a board — but a deal has no lane anyone moves it between",
    ...overrides,
  },
});

describe("design plan", () => {
  test("a complete plan passes", () => {
    expect(lintPageDesignPlan(plan(), { required: true })).toHaveLength(0);
  });

  test("a page created with no brief at all is refused", () => {
    const findings = lintPageDesignPlan(undefined, { required: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.rule).toBe("design-plan");
    expect(findings[0]?.path).toBe("page.json");
  });

  test("names every field that is missing, so the fix is one edit", () => {
    const findings = lintPageDesignPlan(
      plan({
        archetype: undefined,
        hierarchy: undefined,
        containers: undefined,
        defaultsRejected: undefined,
      }),
      { required: true },
    );
    expect(findings).toHaveLength(1);
    for (const field of [
      "archetype",
      "hierarchy",
      "containers",
      "defaultsRejected",
    ]) {
      expect(findings[0]?.message).toContain(field);
    }
  });

  test("an empty rejection list is not a rejection", () => {
    // The field that cannot be filled in without having considered an
    // alternative — which is why `[]` has to read as absent rather than done.
    const findings = lintPageDesignPlan(plan({ defaultsRejected: [] }), {
      required: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("defaultsRejected");
  });

  test("a repair is advised, never refused", () => {
    // A page written before the plan existed must stay repairable without its
    // author being asked to redesign it first.
    const findings = lintPageDesignPlan(plan({ archetype: undefined }), {
      required: false,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  test("a plan with no rejected SHAPE is refused", () => {
    const findings = lintPageDesignPlan(plan({ alternative: undefined }), {
      required: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("alternative");
  });

  test("the alternative must name a shape the archetype does not have", () => {
    // The failure this rule exists for: one composition described twice. A
    // "ledger with a cockpit band" that rejects "a cockpit" rejected nothing —
    // and that is exactly the shape three generated pages arrived at.
    const findings = lintPageDesignPlan(
      plan({
        archetype: "ledger with a cockpit band",
        alternative: "a plain cockpit — too little room for the rows",
      }),
      { required: true },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("names no shape");
  });

  test("rejecting a shape ON THE DATA is a real answer", () => {
    // The rule asks for a comparison, never for a particular outcome: "a board,
    // but nothing here has lanes" is a page that considered one and said no.
    expect(
      lintPageDesignPlan(
        plan({
          archetype: "ledger with a cockpit band",
          alternative:
            "a board — nothing in this data has lanes to move between",
        }),
        { required: true },
      ),
    ).toHaveLength(0);
  });

  test("the old three-field brief still parses", () => {
    // Every page in the database has one of these. Making the new fields
    // required at the SCHEMA would have made them unloadable, which is a
    // migration disguised as a lint.
    const parsed = PageBriefSchema.safeParse({
      product: { job: "j", audience: "a", features: [] },
      design: { layout: "l", signature: "s" },
    });
    expect(parsed.success).toBe(true);
  });
});
