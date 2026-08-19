/**
 * Unit tests for how the pages suite reads a rendered page
 * (`evals/page-judgement.ts`) and for the graded `custom` verdict the design
 * score rides on (`evals/assertions.ts`). Pure + deterministic — no browser,
 * no model.
 *
 * The rule under test that matters most is the first one: a dead renderer and
 * a broken page must not produce the same red line. A baseline recorded with
 * an unreachable browser would otherwise read as "every page regressed", and
 * the message is the only thing separating the two.
 */

import { describe, expect, test } from "bun:test";
import { runAssertions } from "../../../evals/assertions";
import {
  designScoreAtLeast,
  gatePasses,
  type PageJudgement,
} from "../../../evals/page-judgement";
import type { EvalCaseContext, InvokeResult } from "../../../evals/types";

const critique = (score: number): PageJudgement["critique"] => ({
  scores: { design: 8, functionality: 8, craft: 8, originality: 7 },
  score,
  summary: "A focused board.",
  findings: [],
  elevations: [],
  model: "google/gemini-3.7-flash",
});

const judgement = (over: Partial<PageJudgement> = {}): PageJudgement => ({
  mounted: true,
  gate: { pass: true, blocking: [], observations: [] },
  critique: critique(7.8),
  ...over,
});

describe("gatePasses", () => {
  test("a clean render passes", () => {
    expect(gatePasses(judgement())).toBe(true);
  });

  test("an unreachable browser blames the rig, in those words", () => {
    const verdict = gatePasses(
      judgement({ degraded: "no browser backend available" }),
    );
    expect(verdict).toContain("renderer unavailable");
    // The remedy has to be in the message: whoever reads a red line at 2am
    // should not have to find this file to learn it is not the page's fault.
    expect(verdict).toContain("PAGE_RENDER_BROWSER_WS");
  });

  test("a failing gate names every blocking finding", () => {
    const verdict = gatePasses(
      judgement({
        gate: {
          pass: false,
          blocking: [
            'clicking row "GEODIS France" opened an empty overlay',
            "7 elements are cut off at 390px",
          ],
          observations: [],
        },
      }),
    );
    expect(verdict).toContain("empty overlay");
    expect(verdict).toContain("cut off at 390px");
  });

  test("a page that never mounted is reported as such, not as a low score", () => {
    expect(gatePasses(judgement({ mounted: false, critique: null }))).toContain(
      "never mounted",
    );
  });
});

describe("designScoreAtLeast", () => {
  test("passes above the floor and carries the number as partial credit", () => {
    const verdict = designScoreAtLeast(judgement(), 5);
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBeCloseTo(0.78, 5);
    expect(verdict.message).toContain("7.8/10");
  });

  test("fails below the floor but still reports the score", () => {
    const verdict = designScoreAtLeast(
      judgement({ critique: critique(4.2) }),
      5,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBeCloseTo(0.42, 5);
    expect(verdict.message).toContain("4.2/10");
  });

  test("a missing critique fails with the critic's own reason, not a zero score", () => {
    const verdict = designScoreAtLeast(
      judgement({
        critique: null,
        critiqueUnavailable: "the critique ran past its output budget",
      }),
      5,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.message).toContain("output budget");
  });
});

describe("graded custom assertions", () => {
  const result: InvokeResult = {
    text: "",
    toolCalls: [],
    latencyMs: 0,
    toolLatencyMs: 0,
    modelLatencyMs: 0,
  };
  const ctx: EvalCaseContext = {
    conversationId: "c",
    teamId: "t",
    organizationId: "o",
    userId: undefined,
  };

  test("a CustomVerdict's score reaches the report, and its message survives a pass", () => {
    return runAssertions(
      [
        {
          type: "custom",
          name: "design-score",
          fn: () => ({ passed: true, score: 0.78, message: "design 7.8/10" }),
        },
      ],
      result,
      "prompt",
      ctx,
    ).then(([assertion]) => {
      expect(assertion?.passed).toBe(true);
      expect(assertion?.score).toBeCloseTo(0.78, 5);
      // A boolean assertion drops its message on success; a measurement must
      // not — the number IS the result.
      expect(assertion?.message).toBe("design 7.8/10");
    });
  });

  test("an out-of-range score is clamped rather than corrupting the run average", () => {
    return runAssertions(
      [
        {
          type: "custom",
          name: "silly",
          fn: () => ({ passed: true, score: 4 }),
        },
      ],
      result,
      "prompt",
      ctx,
    ).then(([assertion]) => {
      expect(assertion?.score).toBe(1);
    });
  });

  test("plain boolean and string returns still behave as before", async () => {
    const [ok, bad] = await runAssertions(
      [
        { type: "custom", name: "ok", fn: () => true },
        { type: "custom", name: "bad", fn: () => "it broke" },
      ],
      result,
      "prompt",
      ctx,
    );
    expect(ok?.passed).toBe(true);
    expect(ok?.score).toBe(1);
    expect(bad?.passed).toBe(false);
    expect(bad?.message).toBe("it broke");
  });
});
