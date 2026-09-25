import { fitState, planChunks } from "@fretik/shared/decisions/budget";
import { decisionPoint, familyOf } from "@fretik/shared/decisions/points";
import { resolvePolicy } from "@fretik/shared/decisions/policy";
import type {
  DecisionAnswer,
  DecisionMissingReason,
  DecisionRequest,
  DecisionResponse,
  DecisionTransport,
} from "@fretik/shared/schemas/decisions";
import { evaluateChunk } from "./evaluate";
import { takeRateBudget } from "./rate-budget";

/**
 * Run one decision point: policy, budget, then the engine.
 *
 * Every caller goes through here — the HTTP route that background workers
 * reach, and the in-process callers inside this service — so the rules that
 * make a decision safe to send are enforced in ONE place: nothing past the
 * point's allow-list ever reaches the vendor, a state never outgrows its
 * token budget, and no point spends past the per-minute rate.
 *
 * There is no switch. Both transports are zero-data-retention routes, the
 * same content already reaches the chat models, and a point that must not
 * decide is removed from the registry rather than left dormant.
 */

/**
 * A request whose questions do not belong to the point they claim. Our bug,
 * never the provider's: answered 400, never retried, never fallen back.
 */
export const decisionRequestError = (
  request: DecisionRequest,
): string | null => {
  const spec = decisionPoint(request.point);
  for (const [id, question] of Object.entries(request.questions)) {
    const family = spec.families[familyOf(id)];
    if (family === undefined) {
      return `Question "${id}" belongs to no question family of "${request.point}".`;
    }
    if (family.kind !== question.type) {
      return `Question "${id}" is a ${question.type}; "${request.point}" asks a ${family.kind} there.`;
    }
  }
  return null;
};

export const decidePoint = async (
  request: DecisionRequest,
  context: { teamId: string; organizationId?: string },
): Promise<DecisionResponse> => {
  const point = request.point;
  const policy = resolvePolicy(point);
  const fitted = fitState(policy.spec, request.state);
  const plan = planChunks(request.questions, fitted.tokens);

  const admitted = await takeRateBudget(plan.chunks.length, policy.spec.path);
  if (!admitted) return { status: "skipped", point, reason: "rate_limited" };

  const startedAt = Date.now();
  const deadline = startedAt + policy.spec.timeoutMs;
  const trace = {
    point,
    teamId: context.teamId,
    questionVersion: policy.spec.questionVersion,
    ...(request.subject !== undefined
      ? { subjectType: request.subject.type, subjectId: request.subject.id }
      : {}),
  };

  const chunks = await Promise.all(
    plan.chunks.map((questions) =>
      evaluateChunk({
        state: fitted.state,
        questions,
        ...(request.sessionId !== undefined
          ? { sessionId: request.sessionId }
          : {}),
        deadline,
        fallback: policy.spec.fallbackTransport,
        trace,
      }),
    ),
  );

  const answers: Record<string, DecisionAnswer> = {};
  const missing: { id: string; reason: DecisionMissingReason }[] =
    plan.tooLarge.map((id) => ({ id, reason: "too_large" }));
  let transport: DecisionTransport | null = null;
  let modelId: string | undefined;
  let inputTokens: number | undefined;
  let costUsd: number | undefined;
  for (const chunk of chunks) {
    Object.assign(answers, chunk.answers);
    missing.push(...chunk.missing);
    // The request is labelled by the WORSE transport when chunks disagree:
    // one gateway answer in it is enough to keep the whole record out of
    // calibration, which only trusts the pinned model.
    if (chunk.transport === "gateway" || transport === null) {
      transport = chunk.transport ?? transport;
    }
    modelId ??= chunk.modelId;
    if (chunk.inputTokens !== undefined) {
      inputTokens = (inputTokens ?? 0) + chunk.inputTokens;
    }
    if (chunk.costUsd !== undefined) costUsd = (costUsd ?? 0) + chunk.costUsd;
  }

  return {
    status: "answered",
    point,
    policy: policy.echo,
    answers,
    missing,
    transport,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    latencyMs: Date.now() - startedAt,
  };
};
