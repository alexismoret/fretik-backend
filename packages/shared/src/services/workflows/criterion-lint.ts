import { z } from "zod";
import { probabilityOf, thresholdFor } from "../../decisions/policy";
import type { AiServiceContext } from "../../lib/ai-service";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "../../schemas/decisions";
import {
  eventSubscriptions,
  workflowCriterionError,
  type WorkflowTriggerConfig,
} from "../../schemas/workflows";
import { remoteEvaluator, type DecisionEvaluator } from "../decisions/remote";

/**
 * Whether a trigger criterion can gate anything, judged on what it MEANS.
 *
 * Three ways a criterion goes wrong, each invisible once live — it passes the
 * firing it was written against and quietly refuses real ones:
 * - it names one item ("the file IMG_4821"), so no later firing meets it;
 * - it asks for arithmetic ("amount over 1 000"), which the gate judges by
 *   feel, since the decision model cannot compare numbers or dates;
 * - it means "everything" ("any file added to the Drive, whatever its type"),
 *   and the gate, reading it literally, refuses what it does not name — a
 *   REPLACED file is not an added one.
 *
 * These were regexes until 2026-09-24, each a list of phrasings in English and
 * French. They were written against the sentences an eval had produced, and
 * the next run wrote one they did not list ("quel que soit le dossier ou le
 * type de fichier") that went through and filtered a photo. A question about
 * meaning is the decision model's job, in any language and any wording; only
 * the FORM check (a uuid) stays deterministic, in `workflowCriterionError`.
 *
 * Changing a question's wording bumps the point's `questionVersion`.
 */

export const LINT_POINT = "workflow.criterion.lint";

const CONTEXT =
  "A workflow runs on an input (a document, a record, an email, a form answer) only when the input meets the condition in the state.";

export const CRITERION_LINT_QUESTIONS = {
  one: {
    type: "boolean",
    instructions: `${CONTEXT}\nIs this condition about one particular input rather than a kind of input?`,
    criteria: {
      true: "It is about one particular file, record, email or item.",
      false: "It is about a kind of input that many future inputs can be.",
    },
  },
  cmp: {
    type: "boolean",
    instructions: `${CONTEXT}\nDoes deciding this condition require a comparison or a count?`,
    criteria: {
      true: "Deciding it requires comparing a number, an amount, a date or a duration with a value, or counting something.",
      false:
        "It can be decided from what the input is or is about, with no comparison and no count.",
    },
  },
  open: {
    type: "boolean",
    instructions: `${CONTEXT}\nDoes this condition pick out inputs by what they are, or only by how they arrive?`,
    criteria: {
      true: "Only by how or where the input arrives (added, uploaded, received, in some place), or it takes any input.",
      false: "By what the input is, what it is about, or who sent it.",
    },
  },
} satisfies Record<string, DecisionQuestion>;

export type CriterionLintFlag = keyof typeof CRITERION_LINT_QUESTIONS;

/** Checked in this order; the first flag raised is the one reported. */
const FLAGS: readonly CriterionLintFlag[] = ["one", "cmp", "open"];

export const CRITERION_LINT_ERRORS: Readonly<
  Record<CriterionLintFlag, string>
> = {
  one: "A criterion must not name one specific file or item — it has to hold for every future firing, so describe the kind of input instead.",
  cmp: "A criterion cannot compare numbers or dates: the gate judges what an input IS, not arithmetic. Put that check in the playbook's first task instead.",
  open: "A criterion says what an input IS. How it arrives is the trigger's job, and a workflow for every input leaves the criterion empty: the gate reads a sentence literally and refuses what it does not name.",
};

/** The first flag the answer raises past its bar, or null for none — and
 * null when nothing answered: a criterion is never refused on an outage. */
export const readCriterionLint = (
  response: DecisionResponse | null,
): CriterionLintFlag | null => {
  if (response?.status !== "answered") return null;
  for (const flag of FLAGS) {
    const p = probabilityOf(response.answers[flag]);
    const bar = thresholdFor(response.policy, flag);
    if (p !== null && bar !== undefined && p >= bar) return flag;
  }
  return null;
};

// ==================== //
// A MISSING CRITERION  //
// ==================== //

/**
 * The other way a criterion goes wrong: not written at all, on a workflow
 * whose goal is for one kind of input. Every firing then runs the playbook,
 * which sorts the inputs itself — measured, the assistant does this on 1 to
 * 2 turns in 10 even with the rule in its tool description. The workflow's
 * own goal says whether it is narrow; asked here, and answered with a hint.
 */

export const MISSING_POINT = "workflow.criterion.missing";

export const NARROW_QUESTION_ID = "narrow";

export const NARROW_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "The state gives a workflow's goal and what its trigger delivers. Does the goal apply to every input the trigger delivers, or only to some kind among them?",
  criteria: {
    true: "Only to some kind among them: the goal names a kind (only invoices, only complaints) that other delivered inputs are not.",
    false:
      "To every input the trigger delivers: whatever arrives is what the goal is about.",
  },
};

/** What the trigger delivers, in words: its event types and any filter
 * values that are not ids. */
export const describeTrigger = (config: WorkflowTriggerConfig): string =>
  eventSubscriptions(config)
    .map((subscription) => {
      const filters = Object.entries(subscription.filter ?? {})
        .filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" &&
            !z.uuid().safeParse(entry[1]).success,
        )
        .map(([key, value]) => `${key} = ${value}`);
      return filters.length > 0
        ? `${subscription.type} (${filters.join(", ")})`
        : subscription.type;
    })
    .join(", ");

export const readNarrowGoal = (response: DecisionResponse | null): boolean => {
  if (response?.status !== "answered") return false;
  const p = probabilityOf(response.answers[NARROW_QUESTION_ID]);
  const bar = thresholdFor(response.policy, NARROW_QUESTION_ID);
  return p !== null && bar !== undefined && p >= bar;
};

/**
 * Whether an event workflow with no criterion looks meant for one kind of
 * input. False on no answer: a hint that never comes costs nothing.
 */
export const goalWantsCriterion = async (params: {
  workflow: { name: string; goal: string; description: string };
  triggerConfig: WorkflowTriggerConfig;
  context: AiServiceContext;
  evaluator?: DecisionEvaluator;
}): Promise<boolean> => {
  const response = await (params.evaluator ?? remoteEvaluator)(
    {
      point: MISSING_POINT,
      state: {
        name: params.workflow.name,
        goal: params.workflow.goal,
        description: params.workflow.description,
        trigger: describeTrigger(params.triggerConfig),
      },
      questions: { [NARROW_QUESTION_ID]: NARROW_QUESTION },
    },
    params.context,
  );
  return readNarrowGoal(response);
};

// ==================== //
// THE LINT             //
// ==================== //

/**
 * Why this criterion cannot go live, or null. The form check first (free,
 * exact), then one decision call with the three questions.
 */
export const lintCriterion = async (params: {
  criterion: string;
  context: AiServiceContext;
  evaluator?: DecisionEvaluator;
}): Promise<string | null> => {
  const formError = workflowCriterionError(params.criterion);
  if (formError !== null) return formError;
  const response = await (params.evaluator ?? remoteEvaluator)(
    {
      point: LINT_POINT,
      state: { criterion: params.criterion.trim() },
      questions: CRITERION_LINT_QUESTIONS,
    },
    params.context,
  );
  const flag = readCriterionLint(response);
  return flag === null ? null : CRITERION_LINT_ERRORS[flag];
};
