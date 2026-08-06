import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import db from "../../db";
import type { ConversationTaskTerminalStatus } from "../../db/schema";
import {
  aiConversations,
  CONVERSATION_TASK_TERMINAL_STATUSES,
  conversationBackgroundTasks,
  workflowRuns,
} from "../../db/schema";
import { publishConversationTaskResume } from "../../lib/conversation-task-resume";
import { uuidv7TimestampMs } from "../../lib/uuidv7-time";
import type { WorkflowRunStatus } from "../../schemas/workflows";
import { clearConversationActiveStream } from "../ai/active-stream";
import { getTurnLogStatus, TURN_LOG_ORPHAN_MS } from "../ai/turn-log";
import { completeConversationTask } from "./complete";

/** Below this age a pending row is simply young, not lost. */
const RECONCILE_AFTER_MS = 10 * 60 * 1000;

/** Same benefit-of-the-doubt window as the AI service's stream endpoints:
 * a slot claimed milliseconds ago has no turn-log yet, and that's fine. */
const STREAM_CLAIM_GRACE_MS = 15_000;

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
 * Three failure modes, all invisible without it:
 *  - a task whose completion signal was lost (the AI process died between the
 *    run's finalize and the registry write) stays pending forever, and with it
 *    every later task of that conversation, because the fan-in never clears;
 *  - a conversation whose resume signal was lost (published while no AI
 *    process was subscribed) keeps a settled batch unconsumed;
 *  - a turn slot orphaned by a process crash (`active_stream_id` set, dead
 *    turn-log) blocks new prompts and resumes until someone happens to open
 *    the conversation.
 *
 * Both are reconciled from the durable state: the run rows and the registry
 * itself. Idempotent — a task already settled is skipped by
 * `completeConversationTask`'s own guard, and a resume signal is cheap.
 */
export const sweepConversationTasks = async (params?: {
  now?: Date;
}): Promise<{ reconciled: number; signaled: number; slotsCleared: number }> => {
  const now = params?.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_MS);

  // (c) Stuck turn slots. A process that died mid-turn — a resume crashing
  //     after its claim, a chat turn killed between pump and onFinish —
  //     leaves `active_stream_id` set with a dead turn-log behind it. The
  //     stream GET endpoints heal this lazily, but only when someone opens
  //     the conversation; until then the chat 409s every new prompt and the
  //     resume path (which requires the slot) never fires. Reap here so a
  //     crashed conversation unblocks within one sweep, viewers or not.
  //     Runs BEFORE (b): a cleared slot makes its conversation eligible for
  //     the owed-resume signal in the same pass.
  const inFlight = await db
    .select({
      id: aiConversations.id,
      activeStreamId: aiConversations.activeStreamId,
    })
    .from(aiConversations)
    .where(isNotNull(aiConversations.activeStreamId));

  let slotsCleared = 0;
  for (const conv of inFlight) {
    const streamId = conv.activeStreamId;
    if (streamId === null) continue;
    const claimedAt = uuidv7TimestampMs(streamId);
    const freshClaim =
      claimedAt !== null && now.getTime() - claimedAt < STREAM_CLAIM_GRACE_MS;
    if (freshClaim) continue;
    const log = await getTurnLogStatus(streamId);
    // A live producer pings its log every 5s; `ended` with the slot still
    // set means the producer died between the end marker and its cleanup.
    const dead = log.exists
      ? now.getTime() - log.lastEntryMs > TURN_LOG_ORPHAN_MS
      : true;
    if (!dead) continue;
    await clearConversationActiveStream(conv.id, streamId);
    slotsCleared += 1;
  }

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

  return { reconciled, signaled: owed.length, slotsCleared };
};
