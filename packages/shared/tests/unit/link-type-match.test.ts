import { describe, expect, test } from "bun:test";
import {
  DecisionQuestionSchema,
  type DecisionAnswered,
  type DecisionResponse,
} from "../../src/schemas/decisions";
import {
  buildLinkTypeQuestion,
  linkTypeJournalEntry,
  linkTypeQuestionId,
  NEW_TYPE_OPTION,
  readLinkTypeVerdict,
} from "../../src/services/link-types/match-by-meaning";

/**
 * Relation canonicalization by meaning. A wrong reuse files facts under the
 * wrong meaning, so reuse needs a confident, clear winner that is a real
 * candidate, and shadow reuses nothing.
 */

const candidates = [
  { id: "t1", label: "works for", inverseLabel: "employs" },
  { id: "t2", label: "supplies", inverseLabel: null },
];
const questionId = linkTypeQuestionId("employed_by");

const answered = (
  choice: string,
  probability: number,
  confidence: number | null,
  over: Partial<DecisionAnswered> = {},
): DecisionResponse => ({
  status: "answered",
  point: "graph.link-type-match",
  policy: {
    mode: "on",
    questionVersion: 1,
    thresholds: { type: 0.8 },
    minChosenProbability: { type: 0.5 },
  },
  answers: {
    [questionId]: {
      type: "choice",
      choice,
      probabilities: { [choice]: probability },
      ...(confidence !== null ? { confidence } : {}),
    },
  },
  missing: [],
  transport: "openrouter",
  latencyMs: 70,
  ...over,
});

describe("buildLinkTypeQuestion", () => {
  test("offers every candidate by id, both readings, and a way out", () => {
    const question = buildLinkTypeQuestion("employed_by", candidates);
    expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
    const criteria = question.type === "choice" ? question.criteria : {};
    expect(Object.keys(criteria).sort()).toEqual(
      [NEW_TYPE_OPTION, "t1", "t2"].sort(),
    );
    expect(criteria["t1"]).toContain("employs");
  });
});

describe("readLinkTypeVerdict", () => {
  test("a confident, clear winner is reused", () => {
    expect(
      readLinkTypeVerdict(answered("t1", 0.7, 0.9), questionId, candidates),
    ).toEqual({ reuseId: "t1", chosenId: "t1", shadow: false });
  });

  test("an unsure or split answer creates a new type", () => {
    expect(
      readLinkTypeVerdict(answered("t1", 0.7, 0.79), questionId, candidates)
        .reuseId,
    ).toBeNull();
    expect(
      readLinkTypeVerdict(answered("t1", 0.45, 0.95), questionId, candidates)
        .reuseId,
    ).toBeNull();
  });

  test("a missing confidence is not certainty", () => {
    expect(
      readLinkTypeVerdict(answered("t1", 0.9, null), questionId, candidates)
        .reuseId,
    ).toBeNull();
  });

  test('"none of these" and unknown ids are never reused', () => {
    expect(
      readLinkTypeVerdict(
        answered(NEW_TYPE_OPTION, 0.9, 0.95),
        questionId,
        candidates,
      ),
    ).toEqual({ reuseId: null, chosenId: null, shadow: false });
    expect(
      readLinkTypeVerdict(answered("t9", 0.9, 0.95), questionId, candidates)
        .reuseId,
    ).toBeNull();
  });

  test("shadow names the would-be reuse and reuses nothing", () => {
    expect(
      readLinkTypeVerdict(
        answered("t2", 0.9, 0.95, {
          policy: {
            mode: "shadow",
            questionVersion: 1,
            thresholds: { type: 0.8 },
            minChosenProbability: { type: 0.5 },
          },
        }),
        questionId,
        candidates,
      ),
    ).toEqual({ reuseId: null, chosenId: "t2", shadow: true });
  });
});

describe("linkTypeJournalEntry", () => {
  test("a created type carries the legacy label and the would-be reuse", () => {
    const row = linkTypeJournalEntry({
      organizationId: "org",
      teamId: "team",
      fromCollectionId: "c1",
      questionId,
      response: answered("t1", 0.9, 0.95),
      chosenId: "t1",
      reusedId: null,
      legacyCreated: true,
    });
    expect(row).toMatchObject({
      outcome: "created",
      applied: false,
      targetId: "t1",
      choice: "t1",
      legacyLabel: NEW_TYPE_OPTION,
      subjectType: "collection",
      subjectId: "c1",
    });
  });
});
