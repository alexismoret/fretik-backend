import db from "@fretik/shared/db";
import type { ConversationBackgroundTask } from "@fretik/shared/db/schema";
import { countTestRuns } from "@fretik/shared/services/workflows/count-test-runs";

/**
 * The doctrine a builder applies to a TEST run it just finished. Emitted once
 * per resume however many runs came back, because it is a way of working, not
 * a per-run instruction.
 *
 * History worth keeping: until 2026-07-28 this said "download the run's
 * output" when no tool could, so the builder graded run after run on the
 * summary the run wrote about itself. Until 2026-07-29 it then said only "fix
 * with update + run_test, or activate" — no convergence rule, so a prod
 * session re-ran a SUCCEEDED run twice over number formats and data-inherent
 * gaps (3 runs, ~30 min, near-identical deliverables). The classification is
 * that rule.
 */
const TEST_RUN_DOCTRINE =
  "FIRST call get_run — never judge a run from this summary alone. It returns `outputs` with a path per deliverable: OPEN the file and compare it to what was asked. When the conversation holds an example of the output, diff the two in `python` and print the first difference per column — comparing them by eye misses a decimal or an empty column every time. A run that produced no deliverable at all is itself a playbook defect — fix the playbook so it always delivers, with the values it could not establish left empty, rather than debating its report. THEN classify each gap you found: (a) playbook defect — the deliverable's structure or logic does not match what was asked → fix with update + run_test; (b) data gap — the input genuinely lacks the value, any correct run would leave that cell empty → report it as a finding, NEVER as a reason to re-run; (c) spec detail you could have stated upfront (a number format, a label, a sort order) → fold it into the playbook with update and move on WITHOUT a new test — the current deliverable already proves the logic. Deliverable structurally conform → activate now and report the (b)/(c) items alongside. When you update, tighten the existing task in place — appending validation tasks makes every future run longer, not better. A test run costs the user the time and tokens shown above; two rounds without convergence → show the user the remaining difference and ask. NEVER redo the run's work yourself in this chat — the deliverable is produced by the run, not here; reproducing it proves nothing about the workflow. The user has not spoken — only ask them when a decision genuinely needs their input.";

/**
 * What to do about a REAL run: it did the actual work for the user, so the
 * job here is to report it, not to grade a draft.
 */
const REAL_RUN_DOCTRINE =
  "Call get_run for the deliverables, then tell the user what came out of it — the outcome and anything they need to act on. A failure is worth diagnosing before proposing a fix; do not silently relaunch it.";

export interface WorkflowRunContinuation {
  /** One line stating what this run did, for the continuation header. */
  line: string;
  isTest: boolean;
  /** Whoever launched the run — the acting identity for the resumed turn. */
  triggeredByUserId: string | null;
}

/**
 * Turn one finished workflow run into the line the agent reads when its
 * conversation wakes up. Per-task detail stays behind `get_run` so the
 * message never goes stale and stays tiny.
 */
export const buildWorkflowRunContinuation = async (
  task: ConversationBackgroundTask,
): Promise<WorkflowRunContinuation | null> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { id: task.ref },
    columns: {
      workflowId: true,
      status: true,
      outputSummary: true,
      error: true,
      isTest: true,
      triggeredByUserId: true,
      usage: true,
      startedAt: true,
      finishedAt: true,
      sourceConversationId: true,
    },
  });
  if (!run) return null;

  const outcome =
    run.status === "failed" && run.error
      ? `${run.error.code}: ${run.error.message}`
      : (run.outputSummary?.trim() ?? "");

  // What the run cost, on the header line — the builder decides whether
  // another round is worth it against a number, not a feeling. Tokens only,
  // never a currency amount: this message is visible in the conversation.
  const durationMs =
    run.startedAt && run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;
  const weight = [
    ...(durationMs !== null && durationMs > 0
      ? [`${Math.max(1, Math.round(durationMs / 60_000)).toString()} min`]
      : []),
    ...(run.usage.totalTokens > 0
      ? [`${(run.usage.totalTokens / 1_000_000).toFixed(1)}M tokens`]
      : []),
  ].join(", ");

  const testsSoFar =
    run.isTest && run.sourceConversationId
      ? await countTestRuns({
          workflowId: run.workflowId,
          sourceConversationId: run.sourceConversationId,
        })
      : 0;
  const rank = run.isTest ? ` Test run #${testsSoFar.toString()}.` : "";

  const label = run.isTest ? "Test run" : "Run";
  const line = [
    `${label} ${task.ref} of workflow "${task.title}" ${run.status}.${rank}${weight ? ` (${weight})` : ""}`,
    ...(outcome ? [outcome] : []),
  ].join(" ");

  return {
    line,
    isTest: run.isTest,
    triggeredByUserId: run.triggeredByUserId,
  };
};

/** The doctrine block for a batch, given what kinds of run it contains. */
export const workflowRunDoctrine = (params: {
  hasTest: boolean;
  hasReal: boolean;
}): string[] => [
  ...(params.hasTest ? [TEST_RUN_DOCTRINE] : []),
  ...(params.hasReal ? [REAL_RUN_DOCTRINE] : []),
];
