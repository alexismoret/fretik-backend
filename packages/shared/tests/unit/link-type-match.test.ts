import { describe, expect, test } from "bun:test";
import {
  DecisionQuestionSchema,
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
 * candidate.
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
): DecisionResponse => ({
  status: "answered",
  point: "graph.link-type-match",
  policy: {
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
});

describe("buildLinkTypeQuestion", () => {
  test("offers every candidate by id, in one direction only, and a way out", () => {
    const question = buildLinkTypeQuestion("employed_by", candidates);
    expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
    const criteria = question.type === "choice" ? question.criteria : {};
    expect(Object.keys(criteria).sort()).toEqual(
      [NEW_TYPE_OPTION, "t1", "t2"].sort(),
    );
    expect(criteria["t1"]).toBe(
      "The first record works for the second record.",
    );
    // The inverse reading is what made v1 reuse `owns` for `subsidiary_of`:
    // a type is reused in one direction only, so it is never offered.
    expect(criteria["t1"]).not.toContain("employs");
    expect(question.instructions).toContain("the first record employed by");
  });
});

describe("readLinkTypeVerdict", () => {
  test("a confident, clear winner is reused", () => {
    expect(
      readLinkTypeVerdict(answered("t1", 0.7, 0.9), questionId, candidates),
    ).toEqual({ reuseId: "t1", chosenId: "t1" });
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
    ).toEqual({ reuseId: null, chosenId: null });
    expect(
      readLinkTypeVerdict(answered("t9", 0.9, 0.95), questionId, candidates)
        .reuseId,
    ).toBeNull();
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
