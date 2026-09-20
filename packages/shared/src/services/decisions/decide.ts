import { callAiService, type AiServiceContext } from "../../lib/ai-service";
import {
  DecisionResponseSchema,
  type DecisionQuestion,
  type DecisionResponse,
  type DecisionState,
} from "../../schemas/decisions";

/**
 * Ask the AI service to decide — from anywhere that is not the AI service.
 *
 * Returns `null` instead of throwing, and that is the whole design. Every
 * caller of this function has a behaviour for "no answer" that is strictly
 * safer than the one a decision would have produced: the trigger gate
 * launches the workflow, the Drive filer leaves the document at the root. So
 * "could not decide" is an ordinary outcome, not an error — and making it an
 * error would mean each caller writing the same try/catch, with the one that
 * forgets turning a provider blip into a workflow that stopped firing.
 *
 * The timeout here is the caller's own, deliberately longer than the
 * service-side one (1 s): the service aborts its provider call and answers
 * 503, and we would rather read that answer than time out on top of it and
 * lose the reason.
 */
const CLIENT_TIMEOUT_MS = 5_000;

export interface DecideParams {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  context: AiServiceContext;
}

export const decide = async (
  params: DecideParams,
): Promise<DecisionResponse | null> => {
  if (Object.keys(params.questions).length === 0) return null;
  try {
    return await callAiService(
      "/internal/decisions",
      { state: params.state, questions: params.questions },
      DecisionResponseSchema,
      params.context,
      { timeoutMs: CLIENT_TIMEOUT_MS },
    );
  } catch (error) {
    console.warn(
      "[decisions] no answer, falling open:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

/**
 * P(true) for a boolean question, or `null` when the decision did not answer
 * it — which includes a service that answered a DIFFERENT question type under
 * that id. A caller reading a `score` where it asked a `boolean` has a bug or
 * a protocol drift, and quietly coercing one to the other would hide both.
 */
export const booleanProbability = (
  response: DecisionResponse | null,
  questionId: string,
): number | null => {
  const answer = response?.answers[questionId];
  if (answer === undefined || answer.type !== "boolean") return null;
  return answer.probability;
};

/** The selected option for a choice question, or `null` as above. */
export const chosenOption = (
  response: DecisionResponse | null,
  questionId: string,
): { choice: string; probability: number | null } | null => {
  const answer = response?.answers[questionId];
  if (answer === undefined || answer.type !== "choice") return null;
  const probability = answer.probabilities?.[answer.choice];
  return {
    choice: answer.choice,
    probability: typeof probability === "number" ? probability : null,
  };
};
