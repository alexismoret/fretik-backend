import { z } from "zod";
import { DECISION_POINT_KEYS } from "../decisions/keys";

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
 * probability behind it. This file is the contract, deliberately a MIRROR of
 * the AI SDK's evaluation-model shape — with the two constraints the Decisions
 * API adds on top written in rather than discovered as a 400:
 *
 * - a boolean's `criteria` carries BOTH sides or neither (the provider refuses
 *   one side alone);
 * - every rung of a score has a description (the provider refuses a null).
 *
 * The one asymmetry worth knowing before reading any threshold in this
 * codebase: a boolean answer is **P(true)**, not confidence in the answer. A
 * `probability` of 0.02 is a strong "no", not a weak anything. Choice and
 * score answers DO carry a `confidence`, derived by the model from the shape
 * of the whole distribution — which is why a filing decision reads it and a
 * gate decision cannot.
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
export type DecisionStateValue = z.infer<typeof decisionStateValueSchema>;

const instructions = z.string().min(1).max(4000);
const description = z.string().min(1).max(2000);

/**
 * Yes or no. `criteria` spells out what each side MEANS, which is where a
 * vague question becomes a sharp one — "true when the document is an invoice
 * or a credit note; false for quotes and delivery notes" decides cases that
 * "is this an invoice?" leaves to taste.
 */
export const BooleanQuestionSchema = z.object({
  type: z.literal("boolean"),
  instructions,
  criteria: z.object({ true: description, false: description }).optional(),
});

/**
 * The most options one choice may carry — the provider's own ceiling.
 * Anything past it has to be narrowed in code before it is asked.
 */
export const DECISION_MAX_CHOICE_OPTIONS = 255;

/** One of N named options. `criteria` maps each option to its description. */
export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions,
  criteria: z
    .record(z.string().min(1).max(120), description)
    .refine((c) => Object.keys(c).length >= 2, {
      message: "a choice needs at least two options",
    })
    .refine((c) => Object.keys(c).length <= DECISION_MAX_CHOICE_OPTIONS, {
      message: `a choice takes at most ${DECISION_MAX_CHOICE_OPTIONS.toString()} options`,
    }),
});

/** A position on an ordered ladder, indexed from zero. Two to ten rungs. */
export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions,
  criteria: z.array(description).min(2).max(10),
});

export const DecisionQuestionSchema = z.discriminatedUnion("type", [
  BooleanQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>;

/**
 * How many questions ride ONE provider call. Not a limit on a request: the
 * engine splits a larger one into calls of this size against the same state,
 * run in parallel. What it bounds is the blast radius of one failed call —
 * forty questions falling open together is a bad minute, two hundred is an
 * incident.
 */
export const DECISION_CHUNK_QUESTIONS = 40;

/** The most questions one request may carry, across all its chunks. */
export const DECISION_MAX_QUESTIONS = 256;

export const DecisionPointKeySchema = z.enum(DECISION_POINT_KEYS);

/** What the decision is ABOUT — journaled, never sent to the model. */
export const DecisionSubjectSchema = z.object({
  type: z.string().min(1).max(32),
  id: z.string().min(1).max(200),
});
export type DecisionSubject = z.infer<typeof DecisionSubjectSchema>;

export const DecisionRequestSchema = z.object({
  point: DecisionPointKeySchema,
  subject: DecisionSubjectSchema.optional(),
  /** Groups related calls on the provider side (one workflow run, one
   * conversation). OpenRouter caps it at 256 characters. */
  sessionId: z.string().min(1).max(256).optional(),
  state: DecisionStateSchema,
  /** Keyed by caller-chosen ids; answers come back under the same keys. */
  questions: z
    .record(z.string().min(1).max(120), DecisionQuestionSchema)
    .refine((q) => Object.keys(q).length > 0, {
      message: "at least one question is required",
    })
    .refine((q) => Object.keys(q).length <= DECISION_MAX_QUESTIONS, {
      message: `at most ${DECISION_MAX_QUESTIONS.toString()} questions per request`,
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
  /** The model's own certainty, from the distribution's shape. Absent on a
   * transport that does not report it — which is NOT low confidence. */
  confidence: z.number().min(0).max(1).optional(),
});
export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  /** Fractional position in [0, rungs - 1]. */
  score: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** The rung descriptions as the provider echoed them, keyed by index. */
  legend: z.record(z.string(), z.string()).optional(),
});

export const DecisionAnswerSchema = z.discriminatedUnion("type", [
  BooleanAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;
export type BooleanAnswer = z.infer<typeof BooleanAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;

/**
 * Why a question came back without an answer. Per QUESTION, because a large
 * request is several calls and one of them failing says nothing about the
 * others: a caller falls open on the missing ids only.
 *
 * `invalid_request` is kept apart from the outages on purpose. A 400 is OUR
 * bug — a question the provider refuses will be refused on every retry and
 * by every transport — and reading it as "the provider is down" is how a
 * malformed question falls open silently forever.
 */
export const DECISION_MISSING_REASONS = [
  "timeout",
  "unavailable",
  "rate_limited",
  "invalid_request",
  "too_large",
  "no_answer",
] as const;
export type DecisionMissingReason = (typeof DECISION_MISSING_REASONS)[number];

/** Why the whole request was not evaluated. Never an incident by itself. */
export const DECISION_SKIP_REASONS = [
  /** The per-minute budget refused a background point. */
  "rate_limited",
] as const;
export type DecisionSkipReason = (typeof DECISION_SKIP_REASONS)[number];

export const DECISION_TRANSPORTS = ["openrouter", "gateway"] as const;
export type DecisionTransport = (typeof DECISION_TRANSPORTS)[number];

/**
 * The bars the question was asked under, echoed back with the answer. A
 * caller in another container reads its verdict against THESE rather than
 * its own copy of the registry, so a worker still running the previous
 * deploy never judges a new question by an old bar.
 */
export const DecisionPolicyEchoSchema = z.object({
  questionVersion: z.number().int().positive(),
  thresholds: z.record(z.string(), z.number().min(0).max(1)),
  minChosenProbability: z.record(z.string(), z.number().min(0).max(1)),
});
export type DecisionPolicyEcho = z.infer<typeof DecisionPolicyEchoSchema>;

export const DecisionAnsweredSchema = z.object({
  status: z.literal("answered"),
  point: DecisionPointKeySchema,
  policy: DecisionPolicyEchoSchema,
  answers: z.record(z.string(), DecisionAnswerSchema),
  missing: z.array(
    z.object({ id: z.string(), reason: z.enum(DECISION_MISSING_REASONS) }),
  ),
  /** Which transport answered — null when no call succeeded. Kept on every
   * record because the gateway serves a FLOATING model: its answers are fine
   * to act on and wrong to calibrate against. */
  transport: z.enum(DECISION_TRANSPORTS).nullable(),
  modelId: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  /** Exact USD the provider billed, when it reported one. Never estimated. */
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative(),
});
export type DecisionAnswered = z.infer<typeof DecisionAnsweredSchema>;

export const DecisionSkippedSchema = z.object({
  status: z.literal("skipped"),
  point: DecisionPointKeySchema,
  reason: z.enum(DECISION_SKIP_REASONS),
});
export type DecisionSkipped = z.infer<typeof DecisionSkippedSchema>;

export const DecisionResponseSchema = z.discriminatedUnion("status", [
  DecisionAnsweredSchema,
  DecisionSkippedSchema,
]);
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
