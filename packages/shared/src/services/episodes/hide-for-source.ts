import { and, eq, inArray } from "drizzle-orm";
import type { Transaction } from "../../db";
import { aiEpisodes } from "../../db/schema";

/**
 * Cascade-hide the episodes distilled FROM a source that is being deleted.
 * Both run INSIDE the delete transaction, BEFORE the parent row goes: the
 * `conversationId` / `anchorRecordId` FKs are `onDelete: set null`, so the
 * link must still be intact when we match on it. They flip the derived
 * episode `active → demoted` (leaves recall now, purged after 30 days) and
 * return the ids so the caller can drop their vectors post-commit.
 */

/** Conversation episodes distilled from any of the deleted conversations. */
export const hideEpisodesForConversations = async (
  tx: Transaction,
  conversationIds: string[],
): Promise<string[]> => {
  if (conversationIds.length === 0) return [];
  const rows = await tx
    .update(aiEpisodes)
    .set({ state: "demoted", demotedAt: new Date() })
    .where(
      and(
        inArray(aiEpisodes.conversationId, conversationIds),
        eq(aiEpisodes.kind, "conversation"),
        eq(aiEpisodes.state, "active"),
      ),
    )
    .returning({ id: aiEpisodes.id });
  return rows.map((r) => r.id);
};

/** The record-activity episodes anchored on any of the deleted records. */
export const hideEpisodesForRecords = async (
  tx: Transaction,
  recordIds: string[],
): Promise<string[]> => {
  if (recordIds.length === 0) return [];
  const rows = await tx
    .update(aiEpisodes)
    .set({ state: "demoted", demotedAt: new Date() })
    .where(
      and(
        inArray(aiEpisodes.anchorRecordId, recordIds),
        eq(aiEpisodes.kind, "record_activity"),
        eq(aiEpisodes.state, "active"),
      ),
    )
    .returning({ id: aiEpisodes.id });
  return rows.map((r) => r.id);
};
