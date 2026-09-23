import { and, eq, isNotNull } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { triggerWorkflowRun } from "../../lib/trigger-client";
import { WORKFLOW_MAX_DURATION_MINUTES } from "../../schemas/workflows";
import { finalizeRun } from "./finalize-run";
import { closePausedWindow } from "./paused-clock";

/**
 * Resume a workflow run that was parked on a HITL approval, once the user
 * grants/rejects.
 *
 * There is no orchestrator to wake: self-hosted Trigger.dev cannot
 * checkpoint, so the one that asked EXITED rather than hold the workflow's
 * concurrency slot for the human's latency. Resuming therefore means
 * STARTING a fresh orchestrator at the turn the park recorded, with what was
 * left of the run's budget.
 *
 * Called from the shared approval-decision path (the same one the chatbot
 * uses): when the decided approval's conversation belongs to a
 * `needs_approval` workflow run, this is the post-hook that lets the loop
 * continue. A no-op (returns false) for chat conversations, runs that aren't
 * awaiting approval, and approvals already decided.
 */
export const resumeRunFromApproval = async (params: {
  conversationId: string;
  decision: "approved" | "rejected";
}): Promise<boolean> => {
  // Everything the resume needs is read HERE, before the claim below NULLs
  // the two resume columns — `RETURNING` would hand back the cleared values.
  const run = await db.query.workflowRuns.findFirst({
    where: { conversationId: params.conversationId, status: "needs_approval" },
    columns: {
      id: true,
      workflowId: true,
      teamId: true,
      resumeFromTurnIndex: true,
      resumeRemainingMs: true,
    },
  });
  if (!run) return false;

  // Parked, but with nowhere to resume to — the sub-second window in which
  // the turn's transaction has written `needs_approval` but the
  // orchestrator's `/park` callback has not landed yet. Nothing can be
  // resumed from here: starting an orchestrator without a turn index would
  // replay the run from turn 1, i.e. the whole playbook a second time.
  if (run.resumeFromTurnIndex === null) return false;
  const resumeFromTurnIndex = run.resumeFromTurnIndex;

  // CLAIM THE RESUME BEFORE LAUNCHING ANYTHING. Two decisions racing on the
  // same approval (a double-submit, a retried callback) would otherwise each
  // read a parked run and each start an orchestrator — two loops driving one
  // run, which is the failure this shape exists to make impossible.
  //
  // Both predicates below are locks, and either ALONE is enough for that
  // race: the winner flips the status AND clears the resume point, so under
  // READ COMMITTED a loser re-evaluates against the updated row and matches
  // nothing. Removing just one keeps the concurrency test green; removing
  // both turns four concurrent deciders into four orchestrators. They are
  // kept together because they guard different things — the status
  // predicate is also what stops a run CANCELED between the read above and
  // this update from being dragged back to `running`.
  const now = new Date();
  const claimed = await db
    .update(workflowRuns)
    .set({
      status: "running",
      resumeFromTurnIndex: null,
      resumeRemainingMs: null,
      lastHeartbeatAt: now,
      // The wait is over: bank it, so the run's elapsed time resumes from
      // where it froze instead of catching up on the human's thinking time.
      pausedMs: closePausedWindow(now),
      pausedAt: null,
    })
    .where(
      and(
        eq(workflowRuns.id, run.id),
        eq(workflowRuns.status, "needs_approval"),
        isNotNull(workflowRuns.resumeFromTurnIndex),
      ),
    )
    .returning({ id: workflowRuns.id });
  if (claimed.length === 0) return false;

  try {
    const { runId: triggerRunId } = await triggerWorkflowRun(
      {
        runId: run.id,
        workflowId: run.workflowId,
        teamId: run.teamId,
        // Superseded by `remainingMs` on every resume — the orchestrator
        // prefers it — but the payload type requires a value.
        maxDurationMinutes: WORKFLOW_MAX_DURATION_MINUTES,
        startTurnIndex: resumeFromTurnIndex,
        // Normally always set: an orchestrator that had no budget left would
        // have failed the run on TIME_LIMIT before ever parking. The `?? 0`
        // is for a row that predates these columns, and it closes the run
        // `failed(TIME_LIMIT)` on the first turn — loud and finite, where
        // silently granting a fresh full budget per approval would let one
        // run be extended forever by answering it.
        remainingMs: run.resumeRemainingMs ?? 0,
      },
      {
        // Second belt behind the claim: one resume point, one Trigger run.
        idempotencyKey: `workflow-run:${run.id}:resume:${resumeFromTurnIndex.toString()}`,
      },
    );
    await db
      .update(workflowRuns)
      .set({ triggerRunId })
      .where(eq(workflowRuns.id, run.id));
    return true;
  } catch (error) {
    // The claim already moved the run to `running`. Leaving it there with no
    // orchestrator makes it a zombie the stall sweeper only reclaims 20
    // minutes later, so close it here — through `finalizeRun`, so this
    // terminal path journals and notifies like every other one.
    const message = error instanceof Error ? error.message : "trigger failed";
    await finalizeRun({
      runId: run.id,
      status: "failed",
      error: {
        code: "TRIGGER_FAILED",
        message: `The approval was recorded but the run could not be restarted: ${message}`,
      },
    });
    return false;
  }
};
