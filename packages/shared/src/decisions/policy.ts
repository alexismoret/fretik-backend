import { z } from "zod";
import {
  DECISION_MODES,
  type DecisionAnswer,
  type DecisionMode,
  type DecisionPolicyEcho,
} from "../schemas/decisions";
import {
  DECISION_POINT_KEYS,
  isDecisionPointKey,
  type DecisionPointKey,
} from "./keys";
import { decisionPoint, familyOf, type DecisionPointSpec } from "./points";

/**
 * How a point is actually run: the registry's defaults, the operator's
 * emergency overrides, and the deployment's content-egress stance, folded
 * into one answer.
 *
 * Resolved in ONE process — the AI service, where the call is made — and
 * echoed back in every answer (`DecisionPolicyEcho`). A caller in another
 * container reads its thresholds from the echo, never from its own env, so an
 * override cannot be set on one container and forgotten on another.
 */

/**
 * `DECISION_OVERRIDES` — JSON, per point: `{ "workflow.gate": { "mode":
 * "off" } }` or `{ "drive.file": { "thresholds": { "folder": 0.85 } } }`.
 *
 * The emergency lever, not a tuning surface: a threshold change that is meant
 * to last goes into the registry through a reviewed PR, with the calibration
 * that justified it. Strict on purpose — a typo'd point key or family is a
 * boot failure, because an override that silently matches nothing is an
 * operator believing a gate is off while it keeps deciding.
 */
const OverrideEntrySchema = z
  .object({
    mode: z.enum(DECISION_MODES).optional(),
    thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .strict();

export const DecisionOverridesSchema = z.partialRecord(
  z.enum(DECISION_POINT_KEYS),
  OverrideEntrySchema,
);
export type DecisionOverrides = z.infer<typeof DecisionOverridesSchema>;

export const parseDecisionOverrides = (
  raw: string | undefined,
): DecisionOverrides => {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DECISION_OVERRIDES is not valid JSON.");
  }
  const result = DecisionOverridesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `DECISION_OVERRIDES is invalid: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  for (const [key, entry] of Object.entries(result.data)) {
    if (!entry?.thresholds || !isDecisionPointKey(key)) continue;
    const families = decisionPoint(key).families;
    for (const family of Object.keys(entry.thresholds)) {
      if (!(family in families)) {
        throw new Error(
          `DECISION_OVERRIDES: point "${key}" has no question family "${family}".`,
        );
      }
    }
  }
  return result.data;
};

export interface ResolvedPolicy {
  spec: DecisionPointSpec;
  mode: DecisionMode;
  /** False when the point sends content and the deployment forbids it: the
   * point is skipped rather than asked on a state stripped of what it is
   * about. */
  runnable: boolean;
  /** Content keys are dropped from the state before it leaves. */
  redactContent: boolean;
  echo: DecisionPolicyEcho;
}

export const resolvePolicy = (
  key: DecisionPointKey,
  params: { overrides: DecisionOverrides; contentEgress: boolean },
): ResolvedPolicy => {
  const spec = decisionPoint(key);
  const override = params.overrides[key];
  const mode = override?.mode ?? spec.defaultMode;

  const thresholds: Record<string, number> = {};
  const minChosenProbability: Record<string, number> = {};
  for (const [family, definition] of Object.entries(spec.families)) {
    thresholds[family] = override?.thresholds?.[family] ?? definition.threshold;
    if (definition.minChosenProbability !== undefined) {
      minChosenProbability[family] = definition.minChosenProbability;
    }
  }

  return {
    spec,
    mode,
    runnable: spec.egress !== "content" || params.contentEgress,
    redactContent: spec.egress === "redactable" && !params.contentEgress,
    echo: {
      mode: mode === "on" ? "on" : "shadow",
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
