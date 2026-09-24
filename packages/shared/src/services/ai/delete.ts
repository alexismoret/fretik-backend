import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import { deleteSessionFolder } from "../../lib/chatbot-session-storage";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { killSandbox } from "../e2b/kill-sandbox";
import { hideEpisodesForConversations } from "../episodes/hide-for-source";
import { deleteEpisodeVectors } from "../episodes/vectors";

/**
 * Delete conversations. Only an `owner` may delete a collaborative
 * conversation — requested ids the user doesn't own are silently skipped, so
 * a member can never wipe a shared thread out from under the owner.
 *
 * Scoped to the organization, not to the team the caller has open: a chat is
 * its owner's to delete wherever it lives — in another team's project, or in
 * the project a guest was invited to.
 */
export const deleteConversations = async (data: {
  ids: string[];
  organizationId: string;
  userId: string;
}) => {
  const { ids, organizationId, userId } = data;

  if (ids.length === 0) {
    return { rowCount: 0 };
  }

  const ownedRows = await db
    .select({
      conversationId: aiConversationMembers.conversationId,
      teamId: aiConversations.teamId,
      agentType: aiConversations.agentType,
    })
    .from(aiConversationMembers)
    .innerJoin(
      aiConversations,
      eq(aiConversations.id, aiConversationMembers.conversationId),
    )
    .where(
      and(
        inArray(aiConversationMembers.conversationId, ids),
        eq(aiConversationMembers.userId, userId),
        eq(aiConversationMembers.role, "owner"),
        eq(aiConversations.organizationId, organizationId),
      ),
    );

  const ownedIds = ownedRows.map((r) => r.conversationId);
  if (ownedIds.length === 0) {
    return { rowCount: 0 };
  }

  let hiddenEpisodeIds: string[] = [];
  const deleted = await db.transaction(async (tx) => {
    // Hide the conversation episodes distilled from these threads BEFORE the
    // rows go — the `conversationId` FK nulls on delete, so we must match now.
    // They leave recall immediately and the GC purges them after 30 days.
    hiddenEpisodeIds = await hideEpisodesForConversations(tx, ownedIds);

    // Journal first — the rows are gone after this tx, and the events' own
    // conversation FK column nulls on delete; the payload keeps the id. Each
    // chat's event goes to its own team's journal.
    const byTeam = Map.groupBy(ownedRows, (row) => row.teamId);
    for (const [teamId, rows] of byTeam) {
      // eslint-disable-next-line no-await-in-loop -- one statement per team
      await emitDomainEventsBulk({
        tx,
        organizationId,
        teamId,
        actor: { actorType: "user", actorUserId: userId },
        events: rows.map((row) => ({
          type: "conversation.deleted",
          subjectType: "conversation",
          payload: {
            conversationId: row.conversationId,
            agentType: row.agentType,
          },
          dedupKey: `conversation.deleted:${row.conversationId}`,
        })),
      });
    }
    return tx
      .delete(aiConversations)
      .where(inArray(aiConversations.id, ownedIds))
      .returning({ id: aiConversations.id });
  });

  // Drop the recall vectors of the hidden episodes (no FK from `ai_vectors`).
  // Awaited: one indexed DELETE, and a deleted conversation must not keep
  // answering recall.
  await deleteEpisodeVectors(hiddenEpisodeIds);

  // The FK cascade just reaped every `ai_chat_files` row for these
  // conversations; the S3 session folders have no such relationship
  // and would leak forever without an explicit cleanup. Runs in
  // parallel; per-folder failures are logged inside the helper.
  // Also kill any E2B sandbox tied to the conversation so we don't pay
  // for paused-but-orphan sandboxes; killSandbox falls back to
  // metadata lookup if the Redis mapping is gone.
  await Promise.all(
    deleted.flatMap((row) => [
      deleteSessionFolder(row.id),
      killSandbox(row.id).catch((err: unknown) => {
        console.warn(
          `[deleteConversations] killSandbox failed for ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
      }),
    ]),
  );

  return { rowCount: deleted.length };
};
