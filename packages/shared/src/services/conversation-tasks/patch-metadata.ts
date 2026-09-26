import { and, eq } from "drizzle-orm";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskMetadata,
} from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";
import { mergeTaskMetadata } from "./metadata-merge";

/**
 * Merge a kind's live state into its task row while the work is still going.
 *
 * The richer sibling of `updateConversationTaskProgress`, for a kind whose
 * progress is more than two counters — a sub-agent's current step
 * and call log, which its chat card draws. Same contract: top-level keys are
 * merged with `||` in one statement, a settled row is never rewritten by a late
 * tick, and the caller must not fail its work over it. An object-valued key
 * is merged one level down (`metadata-merge.ts`).
 */
export const patchConversationTaskMetadata = async (params: {
  kind: ConversationTaskKind;
  ref: string;
  metadata: ConversationTaskMetadata;
}): Promise<void> => {
  await db
    .update(conversationBackgroundTasks)
    .set({
      metadata: mergeTaskMetadata(params.metadata),
    })
    .where(
      and(
        eq(conversationBackgroundTasks.kind, params.kind),
        eq(conversationBackgroundTasks.ref, params.ref),
        eq(conversationBackgroundTasks.status, "pending"),
      ),
    );
};
