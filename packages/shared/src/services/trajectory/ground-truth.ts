/**
 * Which runs are allowed to teach.
 *
 * `status = 'succeeded'` is the harness saying every task reached a terminal
 * state and none of them said `failed`. That is a statement about the task
 * cursor, not about the work: the agent grades its own tasks through
 * `completeTask`, nothing checks the declared deliverable exists, and a run
 * whose approval a human rejected still closes green.
 *
 * This matters more than it sounds. The one measurement of the question — an
 * audit of a memory system that promoted whatever its judge called a success —
 * found roughly HALF the promoted "successes" had come from runs that failed,
 * because the judge only ever saw the final state. A recipe derived from those
 * teaches a run to reproduce a failure faster.
 *
 * So the rule here is deliberately stricter than the status column, and one of
 * its clauses points the other way from intuition: **a run someone re-ran by
 * hand shortly afterwards is negative evidence**, however green it closed. A
 * human relaunching the same workflow within the window is the only signal in
 * the system that says "that output was not what I wanted", and it is the
 * cheapest ground truth we have.
 *
 * The decision is a pure function of facts the caller gathers, in the same
 * shape as `decideOperatorTarget`: the rule that governs what an agent learns
 * should be readable and testable on its own, not buried in the query that
 * feeds it.
 */

import type { WorkflowRunStatus } from "../../schemas/workflows";

/**
 * How long after a run a manual relaunch still counts as a verdict on it.
 *
 * Two hours: long enough to cover someone opening the result, finding it
 * wrong, and starting again; short enough that the next morning's scheduled
 * work is not read as a complaint about last night's.
 */
export const MANUAL_RERUN_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface RunEvidenceFacts {
  runId: string;
  status: WorkflowRunStatus;
  /** A builder `run_test`: the run exists to try the playbook, not to do work. */
  isTest: boolean;
  /** The playbook pins an output contract, so an empty run did not honour it. */
  declaresDeliverable: boolean;
  /** How many outputs the run collected. */
  outputCount: number;
  /** Approvals a human refused in this run's conversation. */
  rejectedApprovals: number;
  /** Someone relaunched the same workflow by hand inside the window. */
  manualRerunWithinWindow: boolean;
}

export type RunEvidenceReason =
  | "not-succeeded"
  | "test-run"
  | "deliverable-missing"
  | "approval-rejected"
  | "manual-rerun";

export type RunEvidence =
  { usable: true } | { usable: false; reason: RunEvidenceReason };

/**
 * Is this run trustworthy enough to derive a recipe from?
 *
 * Ordered from the cheapest disqualifier to the most surprising one, because
 * the reason is reported and an operator reading "manual-rerun" should be able
 * to trust that the four dull checks already passed.
 */
export const judgeRunEvidence = (facts: RunEvidenceFacts): RunEvidence => {
  if (facts.status !== "succeeded") {
    return { usable: false, reason: "not-succeeded" };
  }
  if (facts.isTest) return { usable: false, reason: "test-run" };
  if (facts.declaresDeliverable && facts.outputCount === 0) {
    return { usable: false, reason: "deliverable-missing" };
  }
  if (facts.rejectedApprovals > 0) {
    return { usable: false, reason: "approval-rejected" };
  }
  if (facts.manualRerunWithinWindow) {
    return { usable: false, reason: "manual-rerun" };
  }
  return { usable: true };
};

/** The minimum a run must expose for the rerun scan below. */
export interface RerunCandidate {
  id: string;
  triggerType: string;
  /** When the run stopped working. A run still open cannot have been re-run yet. */
  finishedAt: Date | null;
  /** When the run was created — a rerun's clock. */
  createdAt: Date;
}

/**
 * Which of these runs were followed by a manual relaunch of the same workflow.
 *
 * Pure, and computed over a set the caller already holds: a rerun is by
 * definition LATER than the run it judges, so a newest-first window of the
 * same workflow already contains every rerun of every run inside it except the
 * newest — and the newest has nothing after it to be judged by.
 *
 * `manual` only. A cron or event run firing in the window is the schedule, not
 * a person disagreeing.
 */
export const detectManualReruns = (
  runs: readonly RerunCandidate[],
  windowMs: number = MANUAL_RERUN_WINDOW_MS,
): Set<string> => {
  const manual = runs
    .filter((r) => r.triggerType === "manual")
    .map((r) => ({ id: r.id, at: r.createdAt.getTime() }))
    .sort((a, b) => a.at - b.at);

  const rerun = new Set<string>();
  for (const run of runs) {
    const finishedAt = run.finishedAt;
    if (finishedAt === null) continue;
    const from = finishedAt.getTime();
    const followed = manual.some(
      (m) => m.id !== run.id && m.at > from && m.at <= from + windowMs,
    );
    if (followed) rerun.add(run.id);
  }
  return rerun;
};
