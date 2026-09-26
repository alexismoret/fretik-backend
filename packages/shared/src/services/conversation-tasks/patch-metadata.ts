import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskMetadata,
} from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";

/**
 * Merge a kind's live state into its task row while the work is still going.
 *
 * The richer sibling of `updateConversationTaskProgress`, for a kind whose
 * progress is more than two counters — a background sub-agent's current step
 * and call log, which its chat card draws. Same contract: top-level keys are
 * merged with `||` in one statement, a settled row is never rewritten by a late
 * tick, and the caller must not fail its work over it.
 */
export const patchConversationTaskMetadata = async (params: {
  kind: ConversationTaskKind;
  ref: string;
  metadata: ConversationTaskMetadata;
}): Promise<void> => {
  await db
    .update(conversationBackgroundTasks)
    .set({
      metadata: sql`coalesce(${conversationBackgroundTasks.metadata}, '{}'::jsonb) || ${JSON.stringify(params.metadata)}::jsonb`,
    })
    .where(
      and(
        eq(conversationBackgroundTasks.kind, params.kind),
        eq(conversationBackgroundTasks.ref, params.ref),
        eq(conversationBackgroundTasks.status, "pending"),
      ),
    );
};
