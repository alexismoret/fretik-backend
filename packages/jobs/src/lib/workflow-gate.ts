import type { Workflow } from "@fretik/shared/db/schema";
import { decisionPoint } from "@fretik/shared/decisions/points";
import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { WorkflowGateDecision } from "@fretik/shared/schemas/workflows";
import type { JournalEntry } from "@fretik/shared/services/decisions/journal";

/**
 * The decisions the trigger gate makes, separated from the queries and the
 * enqueues it makes them with — the same split, for the same reason, as
 * `workflow-trigger-matching.ts` beside it: every rule below is the whole
 * correctness of the gate and none of them needs a database.
 *
 * What the gate is for: an event trigger fires on everything of its kind, so a
 * workflow watching uploads wakes for every file the team adds. Most are not
 * its file, and finding that out used to cost a full agent boot. One sentence
 * per workflow, judged against the event's fact sheet, answers it first for a
 * fraction of a cent.
 *
 * The rule that shapes everything here: **ambiguity launches.** A run that
 * should not have started is visible — it lands as `not_applicable` and
 * anyone can count it. A run that should have started and did not is
 * invisible until a client asks why their document was never processed. So
 * the gate refuses only when the model is confidently negative, and every
 * other path — no criterion, no answer, a point switched off — lets the
 * launch through.
 */

export const GATE_POINT = "workflow.gate";

/** The question id for one workflow's criterion, and its inverse. */
export const gateQuestionId = (workflowId: string): string =>
  `wf:${workflowId}`;
export const workflowIdFromQuestionId = (id: string): string =>
  id.startsWith("wf:") ? id.slice(3) : id;

/**
 * The question asked about one workflow (question version 2).
 *
 * The workflow's NAME and GOAL ride the instructions alongside the criterion,
 * because a criterion is written as a clause ("the document is an invoice")
 * and a clause alone does not say what it is a clause OF.
 *
 * The criteria are NEUTRAL. Version 1 told the model to "prefer true on
 * doubt" AND sat behind a low threshold — asymmetric twice, so P(true) no
 * longer meant anything that could be calibrated. The asymmetry now lives in
 * the threshold alone (the registry's `wf` family), and the model is asked the
 * plain question.
 */
export const buildGateQuestion = (workflow: Workflow): DecisionQuestion => ({
  type: "boolean",
  instructions: [
    `Workflow: "${workflow.name}". Its goal: ${workflow.playbook.goal}`,
    `It must run only when: ${workflow.triggerCriterion ?? ""}`,
    "Does the event described by the state meet that condition?",
  ].join("\n"),
  criteria: {
    true: "The event meets the condition as written.",
    false: "The event does not meet the condition as written.",
  },
});

/**
 * The questions to ask about one event: one per workflow that HAS a criterion.
 *
 * A workflow without one is not asked about and is not gated. That is the
 * migration path and the per-workflow off switch in one mechanism — every
 * workflow that existed before the gate keeps firing exactly as it did, and a
 * team that wants a workflow ungated clears one field.
 */
export const buildGateQuestions = (
  workflows: readonly Workflow[],
): Record<string, DecisionQuestion> => {
  const questions: Record<string, DecisionQuestion> = {};
  for (const workflow of workflows) {
    if (workflow.triggerCriterion === null) continue;
    if (workflow.triggerCriterion.trim().length === 0) continue;
    questions[gateQuestionId(workflow.id)] = buildGateQuestion(workflow);
  }
  return questions;
};

/** What the gate concluded for one workflow, and the record of why. */
export interface GateVerdict {
  workflowId: string;
  allowed: boolean;
  decision: WorkflowGateDecision | null;
}

/** The registry's bar, for records written when no answer carried one. */
const DEFAULT_THRESHOLD = decisionPoint(GATE_POINT).families["wf"]?.threshold;

/**
 * Read the response back into one verdict per workflow.
 *
 * Every branch that is not "the model answered, confidently negative, and the
 * point is live" allows the launch, and each records WHY, so a stretch of them
 * is legible rather than mysterious:
 *   - no criterion → no decision at all (`decision: null`): the run is
 *     ungated and its row says so by carrying nothing;
 *   - no response, a skipped point, or a missing answer → `fell_open`, with
 *     the reason. A run of these means the gate is not being applied, which is
 *     an incident unless the reason is an operator's switch;
 *   - P(meets) at or above the threshold → `allowed`;
 *   - below it, point in `shadow` → `allowed` with `shadow: true`: the verdict
 *     is recorded and not acted on;
 *   - below it, point `on` → `filtered`, the only path that stops a launch.
 *
 * The threshold is the one the SERVICE resolved and echoed, never a local
 * constant: an operator override set on the AI service reaches this worker
 * without being set twice.
 */
export const readGateVerdicts = (
  workflows: readonly Workflow[],
  response: DecisionResponse | null,
  now: Date,
): GateVerdict[] => {
  const decidedAt = now.toISOString();
  const answered = response?.status === "answered" ? response : null;
  const call = answered
    ? {
        latencyMs: answered.latencyMs,
        ...(answered.costUsd !== undefined
          ? { costUsd: answered.costUsd }
          : {}),
        ...(answered.modelId !== undefined
          ? { modelId: answered.modelId }
          : {}),
        ...(answered.transport !== null
          ? { transport: answered.transport }
          : {}),
        questionVersion: answered.policy.questionVersion,
      }
    : {};
  const missingReason = new Map(
    (answered?.missing ?? []).map((entry) => [entry.id, entry.reason]),
  );

  return workflows.map((workflow): GateVerdict => {
    const criterion = workflow.triggerCriterion?.trim() ?? "";
    if (criterion.length === 0) {
      return { workflowId: workflow.id, allowed: true, decision: null };
    }

    const id = gateQuestionId(workflow.id);
    const threshold = answered
      ? thresholdFor(answered.policy, id)
      : DEFAULT_THRESHOLD;
    const probability = probabilityOf(answered?.answers[id]);

    if (probability === null || threshold === undefined) {
      const reason =
        response === null
          ? "unreachable"
          : response.status === "skipped"
            ? response.reason
            : (missingReason.get(id) ?? "no_answer");
      return {
        workflowId: workflow.id,
        allowed: true,
        decision: {
          outcome: "fell_open",
          criterion,
          ...(threshold !== undefined ? { threshold } : {}),
          reason,
          decidedAt,
          ...call,
        },
      };
    }

    const meets = probability >= threshold;
    const shadow = answered?.policy.mode === "shadow";
    return {
      workflowId: workflow.id,
      allowed: meets || shadow,
      decision: {
        outcome: meets || shadow ? "allowed" : "filtered",
        ...(shadow ? { shadow: true } : {}),
        criterion,
        probability,
        threshold,
        decidedAt,
        ...call,
      },
    };
  });
};

/**
 * The journal rows for one gated event: one per workflow that was ASKED
 * about. Ungated workflows (no criterion) have no decision and no row.
 *
 * Numbers only — the criterion stays on the run's own `gate_decision`
 * snapshot. `applied` is false in shadow and on a fall-open: neither verdict
 * changed what happened. The call's cost is split evenly across the
 * questions it answered, so a SUM over the journal is the real bill.
 */
export const gateJournalEntries = (params: {
  verdicts: readonly GateVerdict[];
  eventId: string;
  teamId: string;
  organizationId: string;
}): JournalEntry[] => {
  const decided = params.verdicts.filter(
    (v): v is GateVerdict & { decision: WorkflowGateDecision } =>
      v.decision !== null,
  );
  const version = decisionPoint(GATE_POINT).questionVersion;
  return decided.map(({ workflowId, decision }) => ({
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: GATE_POINT,
    family: "wf",
    questionId: gateQuestionId(workflowId),
    questionVersion: decision.questionVersion ?? version,
    subjectType: "domain_event",
    subjectId: params.eventId,
    targetId: workflowId,
    outcome: decision.outcome,
    applied: decision.outcome !== "fell_open" && decision.shadow !== true,
    reason: decision.reason ?? null,
    probability: decision.probability ?? null,
    confidence: null,
    choice: null,
    threshold: decision.threshold ?? null,
    transport: decision.transport ?? null,
    modelId: decision.modelId ?? null,
    latencyMs: decision.latencyMs ?? null,
    costUsd:
      decision.costUsd !== undefined ? decision.costUsd / decided.length : null,
  }));
};
