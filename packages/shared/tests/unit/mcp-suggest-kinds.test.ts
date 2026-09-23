import { describe, expect, test } from "bun:test";
import {
  type DecisionAnswered,
  DecisionQuestionSchema,
} from "../../src/schemas/decisions";
import {
  buildKindQuestion,
  kindQuestionId,
  readKindVerdict,
} from "../../src/services/external-apps/mcp/suggest-kinds";
import { mcpToolsToDescriptor } from "../../src/services/external-apps/mcp/to-descriptor";

/**
 * The MCP read-only suggestion, off the wire: what is asked about a tool,
 * and when an answer is decided enough to show an admin.
 */

const [items] = mcpToolsToDescriptor({
  key: "acme",
  displayName: "Acme",
  categories: ["productivity"],
  tools: [
    {
      name: "items",
      description: "Work with the items of a collection.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "read", "update", "delete"],
            description: "What to do",
          },
        },
      },
    },
  ],
}).actions;

const answered = (
  answer: {
    choice: string;
    probability?: number;
    confidence?: number;
  },
  mode: "on" | "shadow" = "on",
): DecisionAnswered => ({
  status: "answered",
  point: "external-apps.mcp.suggest-kind",
  policy: {
    mode,
    questionVersion: 1,
    thresholds: { kind: 0.8 },
    minChosenProbability: { kind: 0.6 },
  },
  answers: {
    [kindQuestionId(0)]: {
      type: "choice",
      choice: answer.choice,
      ...(answer.probability !== undefined
        ? { probabilities: { [answer.choice]: answer.probability } }
        : {}),
      ...(answer.confidence !== undefined
        ? { confidence: answer.confidence }
        : {}),
    },
  },
  missing: [],
  transport: "openrouter",
  latencyMs: 90,
});

describe("buildKindQuestion", () => {
  test("a valid choice that shows the arguments deciding the kind", () => {
    if (items === undefined) throw new Error("fixture has one tool");
    const question = buildKindQuestion(items);
    expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
    expect(question.instructions).toContain('"items"');
    expect(question.instructions).toContain("create, read, update, delete");
    expect(
      question.type === "choice" && Object.keys(question.criteria),
    ).toEqual(["read", "write", "destructive", "mixed"]);
  });
});

describe("readKindVerdict", () => {
  test("a decided distribution is a suggestion", () => {
    expect(
      readKindVerdict(
        answered({ choice: "read", probability: 0.9, confidence: 0.85 }),
        0,
      ),
    ).toEqual({ outcome: "suggested", kind: "read" });
  });

  test("below either bar, or with no confidence, it is no suggestion", () => {
    for (const answer of [
      { choice: "read", probability: 0.9, confidence: 0.79 },
      { choice: "read", probability: 0.59, confidence: 0.9 },
      { choice: "read", probability: 0.9 },
      { choice: "sometimes", probability: 0.9, confidence: 0.9 },
    ]) {
      expect(readKindVerdict(answered(answer), 0).outcome).toBe("unsure");
    }
  });

  test("shadow journals the verdict without showing it", () => {
    expect(
      readKindVerdict(
        answered(
          { choice: "read", probability: 0.9, confidence: 0.9 },
          "shadow",
        ),
        0,
      ),
    ).toEqual({ outcome: "shadow", kind: "read" });
  });
});
