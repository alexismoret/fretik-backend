import { and, eq } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskTerminalStatus,
} from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";

/**
 * Settle a background task the conversation was waiting on.
 *
 * The `status = 'pending'` guard lives in the UPDATE itself, so racing
 * terminal paths (a turn-close and a cancel landing together) cannot both
 * report the transition: `transitioned` is true for exactly one caller.
 *
 * `consume: true` settles AND consumes in the same write — for outcomes that
 * must never wake the conversation, namely a launch that failed at creation
 * time while the launching turn is still live and handling the error inline.
 */
export const completeConversationTask = async (params: {
  kind: ConversationTaskKind;
  ref: string;
  status: ConversationTaskTerminalStatus;
  consume?: boolean;
}): Promise<{ conversationId: string | null; transitioned: boolean }> => {
  const now = new Date();
  const rows = await db
    .update(conversationBackgroundTasks)
    .set({
      status: params.status,
      completedAt: now,
      ...(params.consume ? { consumedAt: now } : {}),
    })
    .where(
      and(
        eq(conversationBackgroundTasks.kind, params.kind),
        eq(conversationBackgroundTasks.ref, params.ref),
        eq(conversationBackgroundTasks.status, "pending"),
      ),
    )
    .returning({ conversationId: conversationBackgroundTasks.conversationId });

  const row = rows[0];
  return {
    conversationId: row?.conversationId ?? null,
    transitioned: row !== undefined,
  };
};
