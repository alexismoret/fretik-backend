import { and, eq } from "drizzle-orm";
import db from "../../db";
import { aiConversations } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";

export const updateConversation = async (data: {
  id: string;
  teamId: string;
  userId: string;
  updates: { title?: string; emailOnCompletion?: boolean };
}) => {
  const { id, teamId, userId, updates } = data;

  const [row] = await db
    .update(aiConversations)
    .set(updates)
    .where(
      and(
        eq(aiConversations.id, id),
        eq(aiConversations.teamId, teamId),
        eq(aiConversations.userId, userId),
      ),
    )
    .returning();

  if (!row) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  return row;
};
