import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  fitState,
  MAX_VALUE_CHARS,
  planChunks,
} from "../../src/decisions/budget";
import type { DecisionPointSpec } from "../../src/decisions/points";
import type { DecisionQuestion } from "../../src/schemas/decisions";

/**
 * What leaves for the decision model, and in how many calls.
 */

const spec = (
  state: Partial<DecisionPointSpec["state"]> = {},
): DecisionPointSpec => ({
  key: "workflow.gate",
  purpose: "test",
  questionVersion: 1,
  families: { q: { kind: "boolean", signal: "probability", threshold: 0.5 } },
  noAnswer: "proceed",
  state: {
    maxTokens: 4000,
    admit: ["summary", "filename", "customFields."],
    ...state,
  },
  path: "background",
  timeoutMs: 1000,
  fallbackTransport: true,
  journal: { policy: "all" },
  evalGate: { suites: [] },
});

const boolean: DecisionQuestion = {
  type: "boolean",
  instructions: "Is it so?",
};

describe("fitState", () => {
  test("a key nobody admitted never leaves", () => {
    // An allow-list, never a pass-through: a fact a resolver adds tomorrow
    // does not reach a vendor until someone decides it belongs in a decision.
    const fitted = fitState(spec(), {
      filename: "a.pdf",
      secretNote: "x",
      documentId: "0199",
    });
    expect(fitted.state).toEqual({ filename: "a.pdf" });
    expect(fitted.dropped.map((d) => d.key).sort()).toEqual([
      "documentId",
      "secretNote",
    ]);
  });

  test("a prefix entry admits every key under it", () => {
    const fitted = fitState(spec(), {
      "customFields.total": 12,
      "customFields.kind": "invoice",
    });
    expect(Object.keys(fitted.state)).toEqual([
      "customFields.total",
      "customFields.kind",
    ]);
  });

  test("when the budget binds, the LEAST telling facts go", () => {
    // `admit` order is priority order: the summary is kept, the filename is
    // what the budget sheds. The budget is room for the summary and one token.
    const summary = "word ".repeat(12).trim();
    const room = estimateTokens({}) + estimateTokens({ summary }) + 1;
    const fitted = fitState(spec({ maxTokens: room }), {
      filename: "report.pdf",
      summary,
    });
    expect(Object.keys(fitted.state)).toEqual(["summary"]);
    expect(fitted.dropped).toEqual([{ key: "filename", reason: "budget" }]);
  });

  test("no single value is longer than the clip", () => {
    const fitted = fitState(spec({ maxTokens: 10_000 }), {
      summary: "x".repeat(MAX_VALUE_CHARS * 2),
    });
    const summary = fitted.state["summary"];
    expect(typeof summary === "string" && summary.length).toBe(
      MAX_VALUE_CHARS + 1,
    );
  });
});

describe("planChunks", () => {
  test("41 questions are two calls against one state", () => {
    const questions: Record<string, DecisionQuestion> = {};
    for (let i = 0; i < 41; i += 1) questions[`q:${i.toString()}`] = boolean;
    const plan = planChunks(questions, 100);
    expect(plan.chunks).toHaveLength(2);
    expect(Object.keys(plan.chunks[0] ?? {})).toHaveLength(40);
    expect(Object.keys(plan.chunks[1] ?? {})).toHaveLength(1);
    expect(plan.tooLarge).toEqual([]);
  });

  test("the split is in the order given, so it is reproducible", () => {
    const plan = planChunks({ "q:b": boolean, "q:a": boolean }, 100, 1);
    expect(plan.chunks.map((c) => Object.keys(c)[0])).toEqual(["q:b", "q:a"]);
  });

  test("a question that cannot fit even alone comes back too large", () => {
    const plan = planChunks({ "q:1": boolean }, 31_999);
    expect(plan.chunks).toEqual([]);
    expect(plan.tooLarge).toEqual(["q:1"]);
  });
});
