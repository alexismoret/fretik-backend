import type { DecisionEvaluator } from "@fretik/shared/services/decisions/remote";
import { decidePoint, decisionRequestError } from "./decide-point";

/**
 * The decision engine for code already inside this service — the memory
 * passes, the relation writer, the chat. Same policy code as the HTTP route
 * (`decidePoint`), without a loop back through our own network.
 *
 * Same contract as `remoteEvaluator`: `null` for anything that decided
 * nothing, never a throw, so a caller's "no answer" branch (the legacy path)
 * is the only error handling it needs. A malformed request is our bug, so it
 * is logged loud rather than sent.
 */
export const inProcessEvaluator: DecisionEvaluator = async (
  request,
  context,
) => {
  const requestError = decisionRequestError(request);
  if (requestError !== null) {
    console.error(`[decisions] ${request.point}: ${requestError}`);
    return null;
  }
  try {
    return await decidePoint(request, {
      teamId: context.teamId,
      organizationId: context.organizationId,
    });
  } catch (error) {
    console.warn(
      `[decisions] ${request.point}: engine failed, falling back:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
