import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { aiConversations } from "../../db/schema";
import { deleteSessionFolder } from "../../lib/chatbot-session-storage";
import { killSandbox } from "../e2b/kill-sandbox";

export const deleteConversations = async (data: {
  ids: string[];
  teamId: string;
  userId: string;
}) => {
  const { ids, teamId, userId } = data;

  if (ids.length === 0) {
    return { rowCount: 0 };
  }

  const deleted = await db
    .delete(aiConversations)
    .where(
      and(
        inArray(aiConversations.id, ids),
        eq(aiConversations.teamId, teamId),
        eq(aiConversations.userId, userId),
      ),
    )
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
