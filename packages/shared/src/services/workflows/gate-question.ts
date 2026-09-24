import type { Workflow } from "../../db/schema";
import type { DecisionQuestion } from "../../schemas/decisions";

/**
 * The question the trigger gate asks about one workflow — in one place,
 * because two callers must ask it word for word: the jobs gate that decides
 * real launches, and the "test the condition" backtest that shows a person
 * what the gate WOULD have decided. A backtest asking a different sentence
 * would demonstrate a gate that does not exist.
 *
 * Changing the wording bumps the `workflow.gate` point's `questionVersion`
 * in `decisions/points.ts`: two wordings are two instruments.
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
export const buildGateQuestion = (
  workflow: Pick<Workflow, "name" | "playbook" | "triggerCriterion">,
): DecisionQuestion => ({
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
