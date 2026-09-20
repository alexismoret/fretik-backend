import type { Workflow } from "@fretik/shared/db/schema";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import {
  WORKFLOW_GATE_THRESHOLD,
  type WorkflowGateDecision,
} from "@fretik/shared/schemas/workflows";
import { booleanProbability } from "@fretik/shared/services/decisions/decide";

/**
 * The decisions the trigger gate makes, separated from the queries and the
 * enqueues it makes them with — the same split, for the same reason, as
 * `workflow-trigger-matching.ts` beside it: every rule below is the whole
 * correctness of the gate and none of them needs a database.
 *
 * What the gate is for: an event trigger fires on everything of its kind, so a
 * workflow watching uploads wakes for every file the team adds. Most are not
 * its file, and until now finding that out cost a full agent boot. One
 * sentence per workflow, judged against the event's fact sheet, answers it
 * first for a fraction of a cent.
 *
 * The rule that shapes everything here: **ambiguity launches.** A run that
 * should not have started is visible — it lands as `not_applicable` and
 * anyone can count it. A run that should have started and did not is
 * invisible, and stays invisible until a client asks why their document was
 * never processed. So the gate refuses only when the model is confidently
 * negative, and every other path — no criterion, no answer, an answer for a
 * question nobody asked — lets the launch through.
 */

/** The question id for one workflow's criterion, and its inverse. */
export const gateQuestionId = (workflowId: string): string =>
  `wf:${workflowId}`;
export const workflowIdFromQuestionId = (id: string): string =>
  id.startsWith("wf:") ? id.slice(3) : id;

/**
 * The question asked about one workflow.
 *
 * The workflow's NAME and GOAL ride the instructions alongside the criterion,
 * because a criterion is written as a clause ("the document is an invoice")
 * and a clause alone does not say what it is a clause OF. The `criteria` map
 * then spells out both sides, which is what turns a judgement call into a
 * rule: without it, "is this relevant?" is answered against the model's taste,
 * and the borderline cases — a quote that mentions invoicing, a credit note —
 * land wherever that taste falls.
 */
export const buildGateQuestion = (workflow: Workflow): DecisionQuestion => ({
  type: "boolean",
  instructions: [
    `A workflow named "${workflow.name}" is triggered by workspace events.`,
    `Its goal: ${workflow.playbook.goal}`,
    `It should only run when: ${workflow.triggerCriterion ?? ""}`,
    "Given the event described by the state, does this firing meet that condition?",
  ].join("\n"),
  criteria: {
    true: "The event matches the condition, or there is genuine doubt. Prefer true whenever the state does not clearly rule the workflow out.",
    false:
      "The event clearly does not meet the condition — this workflow has nothing to do with it.",
  },
});

/**
 * The questions to ask about one event: one per workflow that HAS a criterion.
 *
 * A workflow without one is not asked about and is not gated. That is the
 * migration path and the kill switch in the same mechanism — every workflow
 * that existed before this feature keeps firing exactly as it did, and a team
 * that wants a workflow ungated clears one field.
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

/**
 * Read the decision back into one verdict per workflow.
 *
 * Every branch that is not "the model answered, confidently negative" allows
 * the launch, and each records WHY so a stretch of them is legible rather than
 * mysterious:
 *   - no criterion → no decision at all (`decision: null`), the run is
 *     ungated and its row says so by carrying nothing;
 *   - no response, or no answer under this workflow's id → `fell_open`, with
 *     the reason. A run of these means the gate is not being applied, which is
 *     an incident and must not look like a quiet success;
 *   - P(relevant) at or above the threshold → `allowed`;
 *   - below it → `blocked`, the only path that stops a launch.
 */
export const readGateVerdicts = (
  workflows: readonly Workflow[],
  response: DecisionResponse | null,
  now: Date,
  threshold: number = WORKFLOW_GATE_THRESHOLD,
): GateVerdict[] => {
  const decidedAt = now.toISOString();
  const shared = {
    ...(response?.latencyMs !== undefined
      ? { latencyMs: response.latencyMs }
      : {}),
    ...(response?.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
    ...(response?.modelId !== undefined ? { modelId: response.modelId } : {}),
  };

  return workflows.map((workflow): GateVerdict => {
    const criterion = workflow.triggerCriterion?.trim() ?? "";
    if (criterion.length === 0) {
      return { workflowId: workflow.id, allowed: true, decision: null };
    }

    const probability = booleanProbability(
      response,
      gateQuestionId(workflow.id),
    );
    if (probability === null) {
      return {
        workflowId: workflow.id,
        allowed: true,
        decision: {
          outcome: "fell_open",
          criterion,
          threshold,
          reason:
            response === null
              ? "no decision available"
              : "no answer for this workflow",
          decidedAt,
          ...shared,
        },
      };
    }

    const allowed = probability >= threshold;
    return {
      workflowId: workflow.id,
      allowed,
      decision: {
        outcome: allowed ? "allowed" : "blocked",
        criterion,
        probability,
        threshold,
        decidedAt,
        ...shared,
      },
    };
  });
};
