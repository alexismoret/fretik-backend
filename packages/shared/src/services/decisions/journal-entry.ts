import type { DecisionPointKey } from "../../decisions/keys";
import { decisionPoint, familyOf } from "../../decisions/points";
import {
  chosenOf,
  probabilityOf,
  scoreOf,
  thresholdFor,
} from "../../decisions/policy";
import type { DecisionResponse } from "../../schemas/decisions";
import type { JournalEntry, LabelValue } from "./journal";

/**
 * The journal row for one question of one response — the numbers only, read
 * the same way for every point so a sweep over the journal never has to know
 * which caller wrote a row.
 *
 * What differs per point (the outcome's vocabulary, whether the verdict
 * changed anything, what the legacy path said) is the caller's to pass. What
 * is read off the response is not: the signal, the bar it was held to, who
 * answered, and this question's share of the call's cost.
 */
export const answerJournalEntry = (params: {
  organizationId: string;
  teamId: string;
  point: DecisionPointKey;
  questionId: string;
  subjectType: string;
  subjectId: string;
  targetId?: string | null;
  response: DecisionResponse | null;
  /** How many questions the call answered, to split its cost evenly. */
  questionCount: number;
  outcome: string;
  applied: boolean;
  reason?: string | null;
  legacyLabel?: LabelValue;
}): JournalEntry => {
  const { response } = params;
  const answered = response?.status === "answered" ? response : null;
  const answer = answered?.answers[params.questionId];
  const chosen = chosenOf(answer);
  const score = scoreOf(answer);
  const missing = answered?.missing.find((m) => m.id === params.questionId);

  const reason =
    params.reason !== undefined
      ? params.reason
      : response === null
        ? "unreachable"
        : response.status === "skipped"
          ? response.reason
          : (missing?.reason ?? null);

  return {
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: params.point,
    family: familyOf(params.questionId),
    questionId: params.questionId,
    questionVersion:
      answered?.policy.questionVersion ??
      decisionPoint(params.point).questionVersion,
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    targetId: params.targetId ?? null,
    outcome: params.outcome,
    applied: params.applied,
    reason,
    probability: probabilityOf(answer) ?? chosen?.probability ?? null,
    confidence: chosen?.confidence ?? score?.confidence ?? null,
    choice: chosen?.choice ?? null,
    score: score?.score ?? null,
    threshold: answered
      ? (thresholdFor(answered.policy, params.questionId) ?? null)
      : null,
    transport: answered?.transport ?? null,
    modelId: answered?.modelId ?? null,
    latencyMs: answered?.latencyMs ?? null,
    costUsd:
      answered?.costUsd !== undefined
        ? answered.costUsd / Math.max(1, params.questionCount)
        : null,
    ...(params.legacyLabel !== undefined
      ? { legacyLabel: params.legacyLabel }
      : {}),
  };
};
