import { describe, expect, test } from "bun:test";
import {
  DecisionQuestionSchema,
  type DecisionResponse,
} from "../../src/schemas/decisions";
import {
  buildEntityQuestion,
  entityQuestionId,
  mentionKey,
  NEW_ENTITY_OPTION,
  readEntityVerdict,
} from "../../src/services/documents/pre-resolve-mentions";

/**
 * Mentions matched to existing records by meaning. A wrong link attaches a
 * document to the wrong party, so only a confident, clear pick among the
 * offered candidates links; "another one", shadow, or silence leave the
 * mention to the spelling cascade.
 */

const candidates = [
  { id: "r1", label: "Northwind Traders Ltd" },
  { id: "r2", label: "Northwest Supplies" },
];
const questionId = entityQuestionId(0);

const answered = (
  choice: string,
  probability: number,
  confidence: number | null,
  mode: "on" | "shadow" = "on",
): DecisionResponse => ({
  status: "answered",
  point: "graph.entity-match",
  policy: {
    mode,
    questionVersion: 1,
    thresholds: { ent: 0.8 },
    minChosenProbability: { ent: 0.5 },
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
  latencyMs: 80,
});

describe("buildEntityQuestion", () => {
  test("offers the candidates by id and a way out, and is valid", () => {
    const question = buildEntityQuestion("Northwind", candidates);
    expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
    const criteria = question.type === "choice" ? question.criteria : {};
    expect(Object.keys(criteria).sort()).toEqual(
      [NEW_ENTITY_OPTION, "r1", "r2"].sort(),
    );
    expect(question.instructions).toContain('"Northwind"');
  });
});

describe("readEntityVerdict", () => {
  test("a confident, clear pick links", () => {
    expect(
      readEntityVerdict(answered("r1", 0.8, 0.9), questionId, candidates),
    ).toEqual({ linkId: "r1", chosenId: "r1", shadow: false });
  });

  test("unsure, split or unreported confidence does not", () => {
    for (const response of [
      answered("r1", 0.8, 0.79),
      answered("r1", 0.45, 0.95),
      answered("r1", 0.9, null),
    ]) {
      expect(readEntityVerdict(response, questionId, candidates).linkId).toBe(
        null,
      );
    }
  });

  test('"another one" and an unknown id never link', () => {
    expect(
      readEntityVerdict(
        answered(NEW_ENTITY_OPTION, 0.9, 0.95),
        questionId,
        candidates,
      ).linkId,
    ).toBeNull();
    expect(
      readEntityVerdict(answered("r9", 0.9, 0.95), questionId, candidates)
        .linkId,
    ).toBeNull();
  });

  test("shadow names the pick and links nothing", () => {
    expect(
      readEntityVerdict(
        answered("r2", 0.9, 0.95, "shadow"),
        questionId,
        candidates,
      ),
    ).toEqual({ linkId: null, chosenId: "r2", shadow: true });
  });
});

describe("mentionKey", () => {
  test("the hint and the mention meet on the same normalization", () => {
    expect(mentionKey("  Northwind  ")).toBe(mentionKey("Northwind"));
    expect(mentionKey("NORTHWIND")).toBe(mentionKey("northwind"));
  });
});
