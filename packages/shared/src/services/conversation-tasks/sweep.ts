import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import db from "../../db";
import type { ConversationTaskTerminalStatus } from "../../db/schema";
import {
  aiConversations,
  CONVERSATION_TASK_TERMINAL_STATUSES,
  conversationBackgroundTasks,
  workflowRuns,
} from "../../db/schema";
import { publishConversationTaskResume } from "../../lib/conversation-task-resume";
import type { WorkflowRunStatus } from "../../schemas/workflows";
import { completeConversationTask } from "./complete";

/** Below this age a pending row is simply young, not lost. */
const RECONCILE_AFTER_MS = 10 * 60 * 1000;

/** A run's outcome, once it has one — null while it is still going. */
const taskStatusOfRun = (
  status: WorkflowRunStatus,
): ConversationTaskTerminalStatus | null => {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
};

/**
 * Backstop for the wait/notify registry, run by the jobs maintenance sweep.
 *
 * Two failure modes, both invisible without it:
 *  - a task whose completion signal was lost (the AI process died between the
 *    run's finalize and the registry write) stays pending forever, and with it
 *    every later task of that conversation, because the fan-in never clears;
 *  - a conversation whose resume signal was lost (published while no AI
 *    process was subscribed) keeps a settled batch unconsumed.
 *
 * Both are reconciled from the durable state: the run rows and the registry
 * itself. Idempotent — a task already settled is skipped by
 * `completeConversationTask`'s own guard, and a resume signal is cheap.
 */
export const sweepConversationTasks = async (params?: {
  now?: Date;
}): Promise<{ reconciled: number; signaled: number }> => {
  const now = params?.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_MS);

  // (a) Pending tasks whose underlying run is already terminal — or gone.
  const stale = await db
    .select({
      ref: conversationBackgroundTasks.ref,
      runStatus: workflowRuns.status,
    })
    .from(conversationBackgroundTasks)
    .leftJoin(
      workflowRuns,
      sql`${workflowRuns.id}::text = ${conversationBackgroundTasks.ref}`,
    )
    .where(
      and(
        eq(conversationBackgroundTasks.kind, "workflow_run"),
        eq(conversationBackgroundTasks.status, "pending"),
        lt(conversationBackgroundTasks.createdAt, cutoff),
      ),
    );

  let reconciled = 0;
  for (const row of stale) {
    // A missing run row (workflow deleted) means nothing will ever report on
    // it: settle the wait rather than block the conversation forever.
    const status =
      row.runStatus === null ? "failed" : taskStatusOfRun(row.runStatus);
    if (status === null) continue;

    const { transitioned, conversationId } = await completeConversationTask({
      kind: "workflow_run",
      ref: row.ref,
      status,
    });
    if (!transitioned) continue;
    reconciled += 1;
    if (conversationId) await publishConversationTaskResume(conversationId);
  }

  // (b) Conversations owed a resume: everything settled, nothing consumed,
  //     and no turn in flight to be interrupted.
  const owed = await db
    .selectDistinct({
      conversationId: conversationBackgroundTasks.conversationId,
    })
    .from(conversationBackgroundTasks)
    .innerJoin(
      aiConversations,
      eq(aiConversations.id, conversationBackgroundTasks.conversationId),
    )
    .where(
      and(
        inArray(conversationBackgroundTasks.status, [
          ...CONVERSATION_TASK_TERMINAL_STATUSES,
        ]),
        isNull(conversationBackgroundTasks.consumedAt),
        isNull(aiConversations.activeStreamId),
        lt(conversationBackgroundTasks.completedAt, cutoff),
        sql`NOT EXISTS (
          SELECT 1 FROM ${conversationBackgroundTasks} AS still_pending
          WHERE still_pending.conversation_id = ${conversationBackgroundTasks.conversationId}
            AND still_pending.status = 'pending'
        )`,
      ),
    );

  for (const row of owed) {
    await publishConversationTaskResume(row.conversationId);
  }

  return { reconciled, signaled: owed.length };
};
