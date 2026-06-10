import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import { deleteSessionFolder } from "../../lib/chatbot-session-storage";
import { killSandbox } from "../e2b/kill-sandbox";

/**
 * Delete conversations. Only an `owner` may delete a collaborative
 * conversation — requested ids the user doesn't own are silently skipped, so
 * a member can never wipe a shared thread out from under the owner.
 */
export const deleteConversations = async (data: {
  ids: string[];
  teamId: string;
  userId: string;
}) => {
  const { ids, teamId, userId } = data;

  if (ids.length === 0) {
    return { rowCount: 0 };
  }

  const ownedRows = await db
    .select({ conversationId: aiConversationMembers.conversationId })
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
        eq(aiConversations.teamId, teamId),
      ),
    );

  const ownedIds = ownedRows.map((r) => r.conversationId);
  if (ownedIds.length === 0) {
    return { rowCount: 0 };
  }

  const deleted = await db
    .delete(aiConversations)
    .where(inArray(aiConversations.id, ownedIds))
    .returning({ id: aiConversations.id });

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
