import { scoreOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { WorkflowTaskState } from "@fretik/shared/schemas/workflows";
import {
  recordDecisions,
  type JournalEntry,
} from "@fretik/shared/services/decisions/journal";
import { answerJournalEntry } from "@fretik/shared/services/decisions/journal-entry";
import type { DecisionEvaluator } from "@fretik/shared/services/decisions/remote";
import { inProcessEvaluator } from "../decisions/in-process";

/**
 * A second reading of a run that works without converging.
 *
 * The turn handler fails a run after six consecutive turns that call tools
 * and close no task (`NO_CONVERGENCE`). That counter cannot tell a hard task
 * moving slowly from a run going in circles; it only counts. This asks, on
 * each such turn, how close the current task is to done, and journals the
 * score next to the run. Measurement only: nothing here changes a run, and
 * the counters remain the safety net until the scores, read against how runs
 * actually ended, say otherwise.
 */

export const CONVERGENCE_POINT = "workflow.turn.convergence";

export const CONVERGENCE_QUESTION: DecisionQuestion = {
  type: "score",
  instructions:
    "The state is one task of an automated workflow run and what the assistant wrote at the end of its latest turn on it. How close is the task to being finished?",
  criteria: [
    "No progress: the assistant is repeating itself or stuck.",
    "Some progress, far from finished.",
    "Mostly done, a step or two left.",
    "Finished, only not yet reported.",
  ],
};

/** Below the bar the turn reads as stuck, at or above as moving. */
export const readConvergence = (
  response: DecisionResponse | null,
): { score: number | null; stuck: boolean | null } => {
  if (response?.status !== "answered") return { score: null, stuck: null };
  const score = scoreOf(response.answers["conv"]);
  const bar = thresholdFor(response.policy, "conv");
  if (score === null || bar === undefined) return { score: null, stuck: null };
  return { score: score.score, stuck: score.score < bar };
};

export const convergenceJournalEntry = (params: {
  organizationId: string;
  teamId: string;
  runId: string;
  turnIndex: number;
  response: DecisionResponse | null;
}): JournalEntry => {
  const { stuck } = readConvergence(params.response);
  return answerJournalEntry({
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: CONVERGENCE_POINT,
    questionId: "conv",
    journalQuestionId: `conv:${params.turnIndex.toString()}`,
    subjectType: "workflow_run",
    subjectId: params.runId,
    response: params.response,
    questionCount: 1,
    outcome: stuck === null ? "unscored" : stuck ? "stuck" : "moving",
    applied: false,
  });
};

/**
 * Score one non-converging turn and journal it. Fire-and-forget by design:
 * a measurement must never add its latency to a run's turn, and the AI
 * service is long-lived, so the promise is not orphaned. Never throws.
 */
export const measureConvergence = (params: {
  organizationId: string;
  teamId: string;
  runId: string;
  turnIndex: number;
  task: WorkflowTaskState;
  turnText: string;
  evaluator?: DecisionEvaluator;
}): void => {
  void (async () => {
    try {
      const response = await (params.evaluator ?? inProcessEvaluator)(
        {
          point: CONVERGENCE_POINT,
          subject: { type: "workflow_run", id: params.runId },
          sessionId: params.runId,
          state: {
            task: [params.task.title, params.task.instructions]
              .filter(Boolean)
              .join("\n"),
            turn: params.turnText,
          },
          questions: { conv: CONVERGENCE_QUESTION },
        },
        { teamId: params.teamId, organizationId: params.organizationId },
      );
      await recordDecisions([
        convergenceJournalEntry({
          organizationId: params.organizationId,
          teamId: params.teamId,
          runId: params.runId,
          turnIndex: params.turnIndex,
          response,
        }),
      ]);
    } catch (error) {
      console.warn(
        `[workflow-convergence] run ${params.runId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  })();
};
