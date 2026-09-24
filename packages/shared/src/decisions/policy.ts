import type { DecisionAnswer, DecisionPolicyEcho } from "../schemas/decisions";
import type { DecisionPointKey } from "./keys";
import { decisionPoint, familyOf, type DecisionPointSpec } from "./points";

/**
 * The bars a point's questions are asked under, as the registry states them,
 * resolved in the AI service where the call is made and echoed back in every
 * answer (`DecisionPolicyEcho`). A caller in another container reads its
 * verdict against the echo, so both sides of a deploy agree on the bar.
 */
export interface ResolvedPolicy {
  spec: DecisionPointSpec;
  echo: DecisionPolicyEcho;
}

export const resolvePolicy = (key: DecisionPointKey): ResolvedPolicy => {
  const spec = decisionPoint(key);
  const thresholds: Record<string, number> = {};
  const minChosenProbability: Record<string, number> = {};
  for (const [family, definition] of Object.entries(spec.families)) {
    thresholds[family] = definition.threshold;
    if (definition.minChosenProbability !== undefined) {
      minChosenProbability[family] = definition.minChosenProbability;
    }
  }
  return {
    spec,
    echo: {
      questionVersion: spec.questionVersion,
      thresholds,
      minChosenProbability,
    },
  };
};

// ==================== //
// READING AN ANSWER    //
// ==================== //

/**
 * P(true) of a boolean answer, or null when there is none — including an
 * answer of another TYPE under that id. Reading a score where a boolean was
 * asked means a protocol drift or a bug, and coercing one into the other
 * could act on a number that means something else entirely.
 */
export const probabilityOf = (
  answer: DecisionAnswer | undefined,
): number | null =>
  answer !== undefined && answer.type === "boolean" ? answer.probability : null;

export interface ChosenOption {
  choice: string;
  /** The winner's own probability, when the distribution was returned. */
  probability: number | null;
  /** The model's certainty over the whole distribution, when reported. */
  confidence: number | null;
}

export const chosenOf = (
  answer: DecisionAnswer | undefined,
): ChosenOption | null => {
  if (answer === undefined || answer.type !== "choice") return null;
  const probability = answer.probabilities?.[answer.choice];
  return {
    choice: answer.choice,
    probability: typeof probability === "number" ? probability : null,
    confidence: answer.confidence ?? null,
  };
};

export const scoreOf = (
  answer: DecisionAnswer | undefined,
): { score: number; confidence: number | null } | null =>
  answer !== undefined && answer.type === "score"
    ? { score: answer.score, confidence: answer.confidence ?? null }
    : null;

/** The bar a question's family must clear, as the service resolved it. */
export const thresholdFor = (
  echo: DecisionPolicyEcho,
  questionId: string,
): number | undefined => echo.thresholds[familyOf(questionId)];

export const minChosenFor = (
  echo: DecisionPolicyEcho,
  questionId: string,
): number | undefined => echo.minChosenProbability[familyOf(questionId)];
