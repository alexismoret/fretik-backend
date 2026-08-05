import type { Transaction } from "../../db";
import db from "../../db";
import type {
  ConversationTaskKind,
  ConversationTaskMetadata,
} from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";

/**
 * Record that a conversation is now waiting on a piece of background work.
 *
 * Called from the launch seam of whatever produces the work (today
 * `createWorkflowRun`, inside its transaction), so a launch and its wait
 * record commit together — a run that exists is always tracked.
 *
 * Idempotent on `(kind, ref)`: a retried launch of the same run never
 * double-books, and a re-registration after completion is ignored rather than
 * resurrecting a settled wait.
 */
export const registerConversationTask = async (params: {
  tx?: Transaction;
  conversationId: string;
  kind: ConversationTaskKind;
  ref: string;
  title: string;
  metadata?: ConversationTaskMetadata;
}): Promise<void> => {
  const executor = params.tx ?? db;
  await executor
    .insert(conversationBackgroundTasks)
    .values({
      conversationId: params.conversationId,
      kind: params.kind,
      ref: params.ref,
      title: params.title,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    })
    .onConflictDoNothing({
      target: [
        conversationBackgroundTasks.kind,
        conversationBackgroundTasks.ref,
      ],
    });
};
