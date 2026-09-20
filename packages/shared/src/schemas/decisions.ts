import { z } from "zod";

/**
 * The decision protocol — typed questions asked about one state, answered
 * with a probability.
 *
 * It exists because a whole class of platform choices is a judgement, not a
 * computation, and each one was costing an agent to make. "Is this upload the
 * document this workflow is for?" was answered by booting a full executor and
 * letting it conclude, at hundreds of thousands of tokens a launch. "Which
 * folder does this attachment belong in?" was not answered at all — everything
 * landed at the Drive root.
 *
 * A decision model answers both in well under a second for a fraction of a
 * cent, because it does not generate prose: it returns a typed value with the
 * probability behind it. This file is the contract — deliberately a MIRROR of
 * the AI SDK's evaluation-model shape rather than a vocabulary of our own,
 * since inventing one would mean maintaining two mappings and the only thing
 * it would buy is a rename.
 *
 * The one asymmetry worth knowing before reading any threshold in this
 * codebase: a boolean answer is **P(true)**, not confidence in the answer. A
 * `probability` of 0.02 is a strong "no", not a weak anything.
 */

/**
 * A fact sheet value, restated here rather than imported from the facts
 * service: this schema is the WIRE, and a wire that imports a service's types
 * makes the service impossible to change without a protocol change.
 */
const decisionStateValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

/** Flat by contract — see `services/facts/types.ts` for why. */
export const DecisionStateSchema = z.record(
  z.string(),
  decisionStateValueSchema,
);
export type DecisionState = z.infer<typeof DecisionStateSchema>;

/**
 * Yes or no. `criteria` optionally spells out what each side MEANS, which is
 * where a vague question becomes a sharp one — "true when the document is an
 * invoice or a credit note; false for quotes and delivery notes" decides cases
 * that "is this an invoice?" leaves to taste.
 */
export const BooleanQuestionSchema = z.object({
  type: z.literal("boolean"),
  instructions: z.string().min(1).max(4000),
  criteria: z
    .object({
      true: z.string().max(2000).optional(),
      false: z.string().max(2000).optional(),
    })
    .optional(),
});

/** One of N named options. `criteria` maps each option to its description. */
export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1).max(4000),
  criteria: z.record(z.string(), z.string().max(2000).nullable()),
});

/** A position on an ordered ladder, indexed from zero. At least two rungs. */
export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1).max(4000),
  criteria: z.array(z.string().max(2000).nullable()).min(2),
});

export const DecisionQuestionSchema = z.discriminatedUnion("type", [
  BooleanQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;

/**
 * How many questions may ride one call.
 *
 * A ceiling rather than a design limit: the whole point of asking N questions
 * about one state is that the state — the expensive half, since output tokens
 * are free on this endpoint — is paid for once. One upload matched against
 * twenty listening workflows is ONE call, not twenty. The cap only stops a
 * pathological team from putting a 32k context window's worth of questions in
 * front of a 32k context window.
 */
export const DECISION_MAX_QUESTIONS = 40;

export const DecisionRequestSchema = z.object({
  state: DecisionStateSchema,
  /** Keyed by caller-chosen ids; answers come back under the same keys. */
  questions: z
    .record(z.string().min(1).max(120), DecisionQuestionSchema)
    .refine((q) => Object.keys(q).length > 0, {
      message: "at least one question is required",
    })
    .refine((q) => Object.keys(q).length <= DECISION_MAX_QUESTIONS, {
      message: `at most ${DECISION_MAX_QUESTIONS.toString()} questions per call`,
    }),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const BooleanAnswerSchema = z.object({
  type: z.literal("boolean"),
  /** P(true) in [0,1]. NOT confidence in the answer. */
  probability: z.number().min(0).max(1),
});
export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).optional(),
});
export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

export const DecisionAnswerSchema = z.discriminatedUnion("type", [
  BooleanAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

export const DecisionResponseSchema = z.object({
  answers: z.record(z.string(), DecisionAnswerSchema),
  /** Exact USD the provider billed, when it reported one. Never estimated. */
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative(),
  /** Decimals the provider rounded probabilities to — two, today. A threshold
   * finer than this is a threshold the answers cannot express. */
  probabilityDecimals: z.number().int().nonnegative().optional(),
  modelId: z.string().optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
