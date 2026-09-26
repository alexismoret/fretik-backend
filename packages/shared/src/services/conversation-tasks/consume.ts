import { and, eq, inArray, isNull } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationBackgroundTask,
  ConversationTaskKind,
} from "../../db/schema";
import {
  CONVERSATION_TASK_TERMINAL_STATUSES,
  conversationBackgroundTasks,
} from "../../db/schema";

/**
 * Take settled outcomes out of the resume queue because the live turn read
 * them itself.
 *
 * The resume exists for outcomes nobody has seen. When the agent collects a
 * background sub-agent's report during its own turn (`checkAgents`), waking
 * the conversation again with the same report would hand it over twice — so
 * the collection consumes the row, exactly as a resume's claim does.
 *
 * Guarded on `consumed_at IS NULL` and a terminal status in the UPDATE itself:
 * racing a resume's claim, exactly one of the two gets each row, and the rows
 * returned are the ones this caller now owns.
 */
export const consumeConversationTasks = async (params: {
  conversationId: string;
  kind: ConversationTaskKind;
  refs: readonly string[];
}): Promise<ConversationBackgroundTask[]> => {
  if (params.refs.length === 0) return [];
  return db
    .update(conversationBackgroundTasks)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, params.conversationId),
        eq(conversationBackgroundTasks.kind, params.kind),
        inArray(conversationBackgroundTasks.ref, [...params.refs]),
        inArray(conversationBackgroundTasks.status, [
          ...CONVERSATION_TASK_TERMINAL_STATUSES,
        ]),
        isNull(conversationBackgroundTasks.consumedAt),
      ),
    )
    .returning();
};
