import type { DecisionResponse } from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  buildSupportQuestions,
  type ProposedPromotion,
  readSupport,
  supportJournalEntries,
  supportQuestionId,
} from "../../../src/services/memory/promote-support";

/**
 * The promotion rule, counted: a new team fact needs two episodes that state
 * it, a correction needs one. Anything unanswered leaves the promoter's own
 * decision standing, as before the check existed.
 */

const add: ProposedPromotion = {
  action: "ADD",
  path: "learned/invoices-approval.md",
  content: "Invoices above the usual amount need the manager's approval.",
};
const update: ProposedPromotion = {
  action: "UPDATE",
  path: "learned/weekly-report.md",
  content: "The weekly report goes out on Monday mornings.",
};

const answered = (
  probabilities: Record<string, number>,
  mode: "on" | "shadow" = "on",
): DecisionResponse => ({
  status: "answered",
  point: "memory.promote.support",
  policy: {
    mode,
    questionVersion: 1,
    thresholds: { sup: 0.5 },
    minChosenProbability: {},
  },
  answers: Object.fromEntries(
    Object.entries(probabilities).map(([id, probability]) => [
      id,
      { type: "boolean", probability },
    ]),
  ),
  missing: [],
  transport: "openrouter",
  latencyMs: 90,
});

describe("buildSupportQuestions", () => {
  test("one valid question per (fact, episode)", () => {
    const questions = buildSupportQuestions([add, update], 3);
    expect(Object.keys(questions)).toHaveLength(6);
    for (const question of Object.values(questions)) {
      expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
    }
    expect(questions[supportQuestionId(1, 2)]?.instructions).toContain("E3");
  });
});

describe("readSupport", () => {
  test("a new fact needs two supporting episodes", () => {
    const one = readSupport(
      answered({
        [supportQuestionId(0, 0)]: 0.9,
        [supportQuestionId(0, 1)]: 0.2,
      }),
      [add],
      2,
    );
    expect(one.support).toEqual([1]);
    expect(one.allowed).toEqual([false]);

    const two = readSupport(
      answered({
        [supportQuestionId(0, 0)]: 0.9,
        [supportQuestionId(0, 1)]: 0.5,
      }),
      [add],
      2,
    );
    expect(two.allowed).toEqual([true]);
  });

  test("a correction needs one", () => {
    const verdict = readSupport(
      answered({
        [supportQuestionId(0, 0)]: 0.1,
        [supportQuestionId(0, 1)]: 0.8,
      }),
      [update],
      2,
    );
    expect(verdict.allowed).toEqual([true]);
  });

  test("a partly unanswered fact is not judged, and the promoter decides", () => {
    const verdict = readSupport(
      answered({ [supportQuestionId(0, 0)]: 0.1 }),
      [add],
      2,
    );
    expect(verdict.support).toEqual([null]);
    expect(verdict.allowed).toEqual([true]);
    expect(readSupport(null, [add], 2).allowed).toEqual([true]);
  });
});

describe("supportJournalEntries", () => {
  test("rows are keyed by the fact, so another night's check is the same row", () => {
    const response = answered(
      {
        [supportQuestionId(0, 0)]: 0.9,
        [supportQuestionId(0, 1)]: 0.1,
      },
      "shadow",
    );
    const rows = supportJournalEntries({
      organizationId: "org",
      teamId: "team",
      episodeIds: ["e1", "e2"],
      promotions: [add],
      response,
      verdict: readSupport(response, [add], 2),
    });
    expect(rows.map((r) => [r.subjectId, r.questionId, r.outcome])).toEqual([
      ["e1", "sup:learned/invoices-approval.md", "dropped"],
      ["e2", "sup:learned/invoices-approval.md", "dropped"],
    ]);
    expect(rows.map((r) => r.probability)).toEqual([0.9, 0.1]);
    for (const row of rows) expect(row.applied).toBe(false);
  });
});
