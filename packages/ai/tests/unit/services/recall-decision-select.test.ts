import type {
  DecisionRequest,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import type { DecisionEvaluator } from "@fretik/shared/services/decisions/remote";
import { describe, expect, test } from "bun:test";
import type { RecallGathered } from "../../../src/services/recall/candidates";
import {
  buildRelevanceQuestions,
  candidateHits,
  keepOnly,
  readRelevance,
  relevanceQuestionId,
  selectByDecision,
} from "../../../src/services/recall/decision-select";

/**
 * An escalated recall turn. Its contract: the judge's abstention job, one
 * yes/no per candidate, rendered by the unchanged verbatim renderer; and on
 * any doubt (silence, a partial answer) null, so the judge runs.
 */

const gathered: RecallGathered = {
  anchors: [],
  graph: null,
  capabilityResults: [],
  knowledgeResults: [
    {
      sourceType: "memories",
      sourceId: "team/payment-terms.md",
      content: "Suppliers are paid at 45 days end of month.",
      metadata: { path: "team/payment-terms.md" },
      rerankScore: 0.41,
    },
    {
      sourceType: "episodes",
      sourceId: "0199e1",
      content: "The team discussed the office move to the new building.",
      metadata: { title: "Office move" },
      rerankScore: 0.44,
    },
  ],
  documentResults: [
    {
      sourceType: "documents",
      sourceId: "0199d1",
      content: "Lease agreement, 9 years, building B.",
      metadata: { filename: "lease.pdf" },
      rerankScore: 0.39,
    },
  ],
};

const answered = (probabilities: (number | null)[]): DecisionResponse => ({
  status: "answered",
  point: "chat.recall-select",
  policy: {
    questionVersion: 1,
    thresholds: { rel: 0.5 },
    minChosenProbability: {},
  },
  answers: Object.fromEntries(
    probabilities.flatMap((p, i) =>
      p === null
        ? []
        : [[relevanceQuestionId(i), { type: "boolean", probability: p }]],
    ),
  ),
  missing: [],
  transport: "openrouter",
  latencyMs: 120,
});

const evaluatorAnswering =
  (response: DecisionResponse | null): DecisionEvaluator =>
  (_request: DecisionRequest) =>
    Promise.resolve(response);

describe("buildRelevanceQuestions", () => {
  test("one valid question per knowledge hit then per document", () => {
    const questions = buildRelevanceQuestions(candidateHits(gathered));
    expect(Object.keys(questions)).toEqual(["rel:c0", "rel:c1", "rel:c2"]);
    for (const q of Object.values(questions)) {
      expect(DecisionQuestionSchema.safeParse(q).success).toBe(true);
    }
    expect(questions["rel:c2"]?.instructions).toContain("Lease agreement");
  });
});

describe("readRelevance", () => {
  test("every candidate answered: kept at or above the bar", () => {
    expect(readRelevance(answered([0.9, 0.2, 0.5]), 3)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("a partial answer is no answer", () => {
    expect(readRelevance(answered([0.9, null, 0.5]), 3)).toBeNull();
    expect(readRelevance(null, 3)).toBeNull();
  });
});

describe("keepOnly", () => {
  test("drops what was not kept and blanks the knowledge scores", () => {
    const narrowed = keepOnly(gathered, [true, false, true]);
    expect(narrowed.knowledgeResults.map((h) => h.sourceId)).toEqual([
      "team/payment-terms.md",
    ]);
    expect(narrowed.knowledgeResults[0]?.rerankScore).toBeNull();
    expect(narrowed.documentResults.map((h) => h.sourceId)).toEqual(["0199d1"]);
  });

  test("a kept document keeps its score: the renderer's document gate needs one", () => {
    // Blanked, the lease the model kept at 0.97 never rendered.
    const narrowed = keepOnly(gathered, [false, false, true]);
    expect(narrowed.documentResults[0]?.rerankScore).toBe(0.39);
  });

  test("a dropped anchor takes its graph lines and episodes with it", () => {
    const withGraph: RecallGathered = {
      ...gathered,
      anchors: [
        {
          recordId: "rec-horizon",
          collectionId: "col",
          label: "Horizon",
          confidence: 0.9,
          matchedText: "horizon",
          matchType: "fts",
        },
        {
          recordId: "rec-acme",
          collectionId: "col",
          label: "Acme",
          confidence: 0.9,
          matchedText: "Acme",
          matchType: "fts",
        },
      ],
      graph: {
        rendered: "",
        perAnchor: [
          { recordId: "rec-horizon", matchType: "fts", lines: ["- Horizon"] },
          { recordId: "rec-acme", matchType: "fts", lines: ["- Acme"] },
        ],
        episodes: [
          {
            id: "ep-h",
            title: "Horizon kickoff",
            summary: "",
            occurredTo: null,
            anchorLabels: ["Horizon"],
          },
          {
            id: "ep-a",
            title: "Acme renewal",
            summary: "",
            occurredTo: null,
            anchorLabels: ["Acme"],
          },
        ],
      },
    };
    const narrowed = keepOnly(withGraph, [true, true, true], [false, true]);
    expect(narrowed.anchors.map((a) => a.label)).toEqual(["Acme"]);
    expect(narrowed.graph?.perAnchor.map((a) => a.recordId)).toEqual([
      "rec-acme",
    ]);
    expect(narrowed.graph?.episodes.map((e) => e.id)).toEqual(["ep-a"]);
    expect(keepOnly(withGraph, [true, true, true], [false, false]).graph).toBe(
      null,
    );
  });
});

describe("selectByDecision", () => {
  const base = {
    gathered,
    userMessage: "When do we pay suppliers?",
    teamId: "team",
    organizationId: "org",
  };

  test("the kept candidate is rendered, the rest are not", async () => {
    const selection = await selectByDecision({
      ...base,
      evaluator: evaluatorAnswering(answered([0.95, 0.05, 0.1])),
    });
    expect(selection?.block).toContain("45 days end of month");
    expect(selection?.block ?? "").not.toContain("office move");
    expect(selection?.block ?? "").not.toContain("Lease agreement");
  });

  test("nothing kept: an abstention, not a fallback", async () => {
    const selection = await selectByDecision({
      ...base,
      evaluator: evaluatorAnswering(answered([0.1, 0.1, 0.1])),
    });
    expect(selection).not.toBeNull();
    expect(selection?.block ?? null).toBeNull();
  });

  test("a kept document is rendered", async () => {
    const selection = await selectByDecision({
      ...base,
      evaluator: evaluatorAnswering(answered([0.1, 0.1, 0.95])),
    });
    expect(selection?.block).toContain("Lease agreement");
  });

  test("a message naming a record, exactly or not, goes to the judge unasked", async () => {
    // Which of two near-named records a message means is where the model
    // is measured weak; the judge keeps those turns.
    for (const matchType of ["exact", "alias", "trigram"] as const) {
      let asked = false;
      // eslint-disable-next-line no-await-in-loop
      const selection = await selectByDecision({
        ...base,
        gathered: {
          ...gathered,
          anchors: [
            {
              recordId: "rec-1",
              collectionId: "col",
              label: "Nordwind Consulting",
              confidence: 1,
              matchedText: "Nordwind Consulting",
              matchType,
            },
          ],
        },
        evaluator: () => {
          asked = true;
          return Promise.resolve(answered([0.9, 0.9, 0.9]));
        },
      });
      expect(selection).toBeNull();
      expect(asked).toBe(false);
    }
  });

  test("silence or a partial answer hand the turn to the judge", async () => {
    for (const response of [answered([0.95, null, 0.1]), null]) {
      // eslint-disable-next-line no-await-in-loop
      const selection = await selectByDecision({
        ...base,
        evaluator: evaluatorAnswering(response),
      });
      expect(selection).toBeNull();
    }
  });
});
