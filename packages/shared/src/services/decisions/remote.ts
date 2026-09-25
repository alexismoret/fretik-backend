import { decisionPoint } from "../../decisions/points";
import { callAiService, type AiServiceContext } from "../../lib/ai-service";
import {
  DecisionResponseSchema,
  type DecisionAnswered,
  type DecisionRequest,
  type DecisionResponse,
} from "../../schemas/decisions";

/**
 * How a caller reaches the decision engine. Workers (the trigger gate, the
 * Drive filer) take the remote one below; code already inside the AI service
 * injects `decidePoint` directly. Both land in the same policy code, so a
 * rule about what may be sent cannot be enforced on one path and forgotten on
 * the other.
 *
 * `null` means the service itself could not be reached. Every caller has a
 * behaviour for "no answer" that is strictly safer than the one a decision
 * would have produced — the gate launches, the filer leaves the document where
 * it is — so an unreachable service is an ordinary outcome, not an error each
 * caller must remember to catch.
 */
export type DecisionEvaluator = (
  request: DecisionRequest,
  context: AiServiceContext,
) => Promise<DecisionResponse | null>;

/** Slack on top of the point's own deadline, so the service's timeout — and
 * its per-question `missing` reasons — arrive before ours fires and loses
 * them. */
const CLIENT_SLACK_MS = 3_000;

export const remoteEvaluator: DecisionEvaluator = async (request, context) => {
  try {
    return await callAiService(
      "/internal/decisions",
      request,
      DecisionResponseSchema,
      context,
      { timeoutMs: decisionPoint(request.point).timeoutMs + CLIENT_SLACK_MS },
    );
  } catch (error) {
    console.warn(
      `[decisions] ${request.point}: engine unreachable, falling open:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

/** The answered response, or null for anything that decided nothing. */
export const answeredOf = (
  response: DecisionResponse | null,
): DecisionAnswered | null =>
  response !== null && response.status === "answered" ? response : null;
