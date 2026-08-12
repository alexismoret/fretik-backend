import { eq } from "drizzle-orm";
import db from "../../db";
import { workflowRuns } from "../../db/schema";
import { completeWorkflowWaitToken } from "../../lib/trigger-client";
import { closePausedWindow } from "./paused-clock";

/**
 * Resume a workflow run that was parked on a HITL approval, once the user
 * grants/rejects. Completes the run's Trigger.dev wait token (which unblocks
 * the orchestrator's `wait.forToken`) and flips the run back to `running`.
 *
 * Called from the shared approval-decision path (the same one the chatbot
 * uses): when the decided approval's conversation belongs to a
 * `needs_approval` workflow run, this is the post-hook that lets the loop
 * continue. A no-op (returns false) for chat conversations or runs that
 * aren't awaiting approval.
 */
export const resumeRunFromApproval = async (params: {
  conversationId: string;
  decision: "approved" | "rejected";
}): Promise<boolean> => {
  const run = await db.query.workflowRuns.findFirst({
    where: { conversationId: params.conversationId, status: "needs_approval" },
    columns: { id: true, waitTokenId: true },
  });
  if (!run || !run.waitTokenId) return false;

  await completeWorkflowWaitToken(run.waitTokenId, params.decision);
  const now = new Date();
  await db
    .update(workflowRuns)
    .set({
      status: "running",
      waitTokenId: null,
      lastHeartbeatAt: now,
      // The wait is over: bank it, so the run's elapsed time resumes from
      // where it froze instead of catching up on the human's thinking time.
      pausedMs: closePausedWindow(now),
      pausedAt: null,
    })
    .where(eq(workflowRuns.id, run.id));
  return true;
};
