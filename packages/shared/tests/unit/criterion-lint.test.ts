import { describe, expect, test } from "bun:test";
import type {
  DecisionRequest,
  DecisionResponse,
} from "../../src/schemas/decisions";
import { DecisionRequestSchema } from "../../src/schemas/decisions";
import type { DecisionEvaluator } from "../../src/services/decisions/remote";
import {
  CRITERION_LINT_ERRORS,
  CRITERION_LINT_QUESTIONS,
  describeTrigger,
  goalWantsCriterion,
  lintCriterion,
  readCriterionLint,
  readNarrowGoal,
} from "../../src/services/workflows/criterion-lint";

/**
 * How the criterion lint reads the decision model. What the model answers
 * about real sentences is measured in `evals:decisions`; this pins what the
 * product does with an answer — and with no answer at all.
 */

const CONTEXT = { teamId: "team", organizationId: "org" };

const answeredWith = (
  probabilities: Partial<Record<"one" | "cmp" | "open", number>>,
): DecisionResponse => ({
  status: "answered",
  point: "workflow.criterion.lint",
  policy: {
    questionVersion: 1,
    thresholds: { one: 0.8, cmp: 0.8, open: 0.8 },
    minChosenProbability: {},
  },
  answers: Object.fromEntries(
    Object.entries(probabilities).map(([id, p]) => [
      id,
      { type: "boolean", probability: p },
    ]),
  ),
  missing: [],
  transport: "openrouter",
  latencyMs: 10,
});

const recording = (response: DecisionResponse | null) => {
  const requests: DecisionRequest[] = [];
  const evaluator: DecisionEvaluator = (request) => {
    requests.push(request);
    return Promise.resolve(response);
  };
  return { requests, evaluator };
};

describe("the lint request", () => {
  test("passes the wire schema", () => {
    const request = {
      point: "workflow.criterion.lint",
      state: { criterion: "The document is a supplier invoice." },
      questions: CRITERION_LINT_QUESTIONS,
    };
    expect(DecisionRequestSchema.safeParse(request).success).toBe(true);
  });

  test("sends the criterion alone, trimmed", async () => {
    const { requests, evaluator } = recording(answeredWith({}));
    await lintCriterion({
      criterion: "  The document is a supplier invoice.  ",
      context: CONTEXT,
      evaluator,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toEqual({
      criterion: "The document is a supplier invoice.",
    });
  });

  test("a malformed criterion is refused before any call", async () => {
    const { requests, evaluator } = recording(answeredWith({}));
    const error = await lintCriterion({
      criterion: "The document id is 0199a3b2-7c1d-7e4f-9a2b-1c3d4e5f6a7b.",
      context: CONTEXT,
      evaluator,
    });
    expect(error).toContain("specific id");
    expect(requests).toHaveLength(0);
  });
});

describe("readCriterionLint", () => {
  test("a flag at or above its bar refuses, with that flag's reason", async () => {
    for (const flag of ["one", "cmp", "open"] as const) {
      const { evaluator } = recording(answeredWith({ [flag]: 0.8 }));
      const error = await lintCriterion({
        criterion: "The document is a supplier invoice.",
        context: CONTEXT,
        evaluator,
      });
      expect(error).toBe(CRITERION_LINT_ERRORS[flag]);
    }
  });

  test("below every bar, the criterion goes through", () => {
    expect(
      readCriterionLint(answeredWith({ one: 0.79, cmp: 0.2, open: 0.01 })),
    ).toBeNull();
  });

  test("several flags report the first in order: one, cmp, open", () => {
    expect(readCriterionLint(answeredWith({ open: 0.95, cmp: 0.9 }))).toBe(
      "cmp",
    );
  });

  test("no answer never refuses a criterion", async () => {
    // An outage must not stop anyone from writing a workflow: a flawed
    // criterion that slips through still shows as `filtered` runs.
    expect(readCriterionLint(null)).toBeNull();
    const { evaluator } = recording(null);
    expect(
      await lintCriterion({
        criterion: "The document is a supplier invoice.",
        context: CONTEXT,
        evaluator,
      }),
    ).toBeNull();
  });
});

describe("a missing criterion", () => {
  const narrowAnswer = (p: number): DecisionResponse => ({
    status: "answered",
    point: "workflow.criterion.missing",
    policy: {
      questionVersion: 1,
      thresholds: { narrow: 0.55 },
      minChosenProbability: {},
    },
    answers: { narrow: { type: "boolean", probability: p } },
    missing: [],
    transport: "openrouter",
    latencyMs: 10,
  });

  test("the trigger is described in words, ids left out", () => {
    // A folder uuid says nothing the model can read; a collection key does.
    expect(
      describeTrigger({
        event: {
          events: [
            {
              type: "document.uploaded",
              filter: { folderId: "0199a3b2-7c1d-7e4f-9a2b-1c3d4e5f6a7b" },
            },
            { type: "record.created", filter: { collectionKey: "companies" } },
          ],
        },
      }),
    ).toBe("document.uploaded, record.created (collectionKey = companies)");
  });

  test("a goal read as narrow at or above the bar asks for a criterion", () => {
    expect(readNarrowGoal(narrowAnswer(0.55))).toBe(true);
    expect(readNarrowGoal(narrowAnswer(0.54))).toBe(false);
  });

  test("no answer gives no hint", async () => {
    const { evaluator } = recording(null);
    expect(
      await goalWantsCriterion({
        workflow: {
          name: "Invoices",
          goal: "Extract invoices.",
          description: "",
        },
        triggerConfig: { event: { events: [{ type: "document.uploaded" }] } },
        context: CONTEXT,
        evaluator,
      }),
    ).toBe(false);
  });
});
