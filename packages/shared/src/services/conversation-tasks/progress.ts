import { and, eq, sql } from "drizzle-orm";
import db from "../../db";
import type { ConversationTaskKind } from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";

/**
 * Publish how far a piece of background work has got.
 *
 * The ONE place any kind reports progress to the UI. Whatever the work is —
 * rows written, steps run, files processed — it lands in the same two numbers
 * on the task row the chat already polls, so the chat needs no per-kind query,
 * endpoint or component to show a bar. A kind that adds itself to the registry
 * gets the display for free by calling this.
 *
 * Merged into `metadata` rather than written over it: the kind's own display
 * fields (a workflow id, an import's target type) live in the same jsonb and
 * must survive a progress tick. `||` does that in one atomic statement, so two
 * concurrent ticks cannot lose each other's keys.
 *
 * Best-effort by contract: progress is a courtesy to whoever is watching, never
 * the record of what happened. The caller must not fail its work over it.
 */
export const updateConversationTaskProgress = async (params: {
  kind: ConversationTaskKind;
  ref: string;
  done: number;
  total: number;
}): Promise<void> => {
  const patch = JSON.stringify({
    progressDone: params.done,
    progressTotal: params.total,
  });
  await db
    .update(conversationBackgroundTasks)
    .set({
      metadata: sql`coalesce(${conversationBackgroundTasks.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
    })
    .where(
      and(
        eq(conversationBackgroundTasks.kind, params.kind),
        eq(conversationBackgroundTasks.ref, params.ref),
        // A settled task's counters are history; a late tick must not rewrite
        // them.
        eq(conversationBackgroundTasks.status, "pending"),
      ),
    );
};
