import {
  DECISION_MAX_QUESTIONS,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";
import { openrouterClient } from "../../lib/model-registry/transports/openrouter";
import { traceExternalCall } from "../../lib/trace-tool";

/**
 * The ONE place in the monorepo that calls a decision model.
 *
 * Two experimental surfaces are stacked here — `experimental_evaluate` on the
 * AI SDK's side, `/api/alpha/decisions` on OpenRouter's — and either can
 * change shape without a major version. Keeping every caller behind this
 * function means a break is one file to fix rather than a hunt, which is the
 * whole reason it exists as a seam and not as a helper each caller inlines.
 *
 * It is DELIBERATELY outside the model registry. `model_live_state` and every
 * profile derived from it describe chat-completions models: reasoning ladders,
 * cache shapes, `provider.require_parameters`, the eligibility floors a team's
 * pick is measured against. A decision model has none of those — it does not
 * speak that wire format at all — so folding it in would mean teaching the
 * registry to hold a second kind of thing and every reader to ask which kind
 * it got. One fixed model, named here, resolved nowhere else.
 */

/**
 * The decision model. Pinned rather than floating on `~typesafe/jev-latest`:
 * this thing decides whether workflows run, and a silently swapped model is a
 * silently changed threshold. Overridable for an operator A/B, never for a
 * team — there is nothing here a team could reason about.
 */
const DECISION_MODEL_ID =
  process.env["DECISION_MODEL_ID"] ?? "typesafe/jev-1.13";

/**
 * A decision must be cheaper than the thing it saves, in latency as much as
 * money. The endpoint answers in 70-500 ms; a second means it is not
 * answering, and every caller falls open, so waiting longer buys nothing but
 * a slower fallback.
 */
const DECISION_TIMEOUT_MS = Number.parseInt(
  process.env["DECISION_TIMEOUT_MS"] ?? "",
  10,
);
const TIMEOUT_MS = Number.isFinite(DECISION_TIMEOUT_MS)
  ? DECISION_TIMEOUT_MS
  : 1_000;

/**
 * The kill switch. Read at MODULE LOAD, like `RECALL_MODE` and
 * `STANDING_MODE` — it takes effect on the next restart, never mid-process,
 * so a batch of decisions cannot be half-made.
 *
 * Off means every caller sees "no answer" and takes its fail-open path, which
 * for the trigger gate is the behaviour that shipped before any of this
 * existed. That is the property that makes turning it off safe at any hour.
 */
const DECISIONS_ENABLED = process.env["DECISIONS_ENABLED"] !== "false";

export const decisionsEnabled = (): boolean => DECISIONS_ENABLED;

/** Raised when no answer could be obtained. Callers fall open on it. */
export class DecisionUnavailableError extends Error {
  constructor(
    readonly reason: "disabled" | "timeout" | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "DecisionUnavailableError";
  }
}

/**
 * Our question shape is a mirror of the SDK's, so this is a cast in spirit —
 * written as an explicit map anyway, because the two CAN drift and a silent
 * structural match is exactly the kind of coupling that breaks on a minor
 * version with no error.
 */
const toSdkQuestion = (question: DecisionQuestion): EvaluationQuestion => {
  switch (question.type) {
    case "boolean":
      return {
        type: "boolean",
        instructions: question.instructions,
        ...(question.criteria ? { criteria: question.criteria } : {}),
      };
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: question.criteria,
      };
  }
};

/** The exact USD the provider billed, when it reported one. */
const readCostUsd = (metadata: unknown): number | undefined => {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const openrouter = Reflect.get(metadata, "openrouter");
  if (typeof openrouter !== "object" || openrouter === null) return undefined;
  const cost: unknown = Reflect.get(openrouter, "cost");
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
};

/**
 * Ask every question about one state, in one call.
 *
 * NEVER a partial result: the SDK contract is all answers or none, which is
 * what lets a caller treat a thrown `DecisionUnavailableError` as "decide
 * nothing" instead of having to reason about which half came back.
 */
export const evaluateDecisions = async (
  request: DecisionRequest,
): Promise<DecisionResponse> => {
  if (!DECISIONS_ENABLED) {
    throw new DecisionUnavailableError("disabled", "decisions are disabled");
  }
  const questionCount = Object.keys(request.questions).length;
  if (questionCount === 0 || questionCount > DECISION_MAX_QUESTIONS) {
    throw new DecisionUnavailableError(
      "provider_error",
      `expected 1..${DECISION_MAX_QUESTIONS.toString()} questions, got ${questionCount.toString()}`,
    );
  }

  const questions: Record<string, EvaluationQuestion> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = toSdkQuestion(question);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    return await traceExternalCall(
      "decision",
      { modelId: DECISION_MODEL_ID, questionCount, state: request.state },
      async () => {
        const result = await evaluate({
          model: openrouterClient().evaluationModel(DECISION_MODEL_ID),
          state: request.state,
          questions,
          // The SDK retries transient provider failures by default. One
          // attempt here: a retried decision has already blown the latency
          // budget the caller allowed, and the fail-open path is cheaper than
          // a slow right answer.
          maxRetries: 0,
          abortSignal: controller.signal,
        });

        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, answer] of Object.entries(result.answers)) {
          answers[id] = answer;
        }
        const costUsd = readCostUsd(result.providerMetadata);
        const response: DecisionResponse = {
          answers,
          latencyMs: Date.now() - startedAt,
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(result.rounding?.probabilityDecimals !== undefined
            ? { probabilityDecimals: result.rounding.probabilityDecimals }
            : {}),
          ...(result.response.modelId !== ""
            ? { modelId: result.response.modelId }
            : {}),
        };
        return response;
      },
      (response) => ({
        ...(response.costUsd !== undefined
          ? { costUsd: response.costUsd }
          : {}),
        output: { answers: response.answers },
        metadata: {
          latencyMs: response.latencyMs,
          questionCount,
          modelId: response.modelId ?? DECISION_MODEL_ID,
        },
      }),
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DecisionUnavailableError(
        "timeout",
        `decision timed out after ${TIMEOUT_MS.toString()}ms`,
      );
    }
    throw new DecisionUnavailableError(
      "provider_error",
      error instanceof Error ? error.message : "decision provider failed",
    );
  } finally {
    clearTimeout(timeout);
  }
};
