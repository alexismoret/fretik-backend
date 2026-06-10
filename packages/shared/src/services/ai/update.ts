import { eq } from "drizzle-orm";
import db from "../../db";
import { aiConversations } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { SerializedConversation } from "./conversation-serializer";
import { getConversation } from "./get";

/**
 * Rename a conversation. Any participant may rename (flat model). The email
 * opt-in is no longer a conversation field — it's per-member, written through
 * `setMemberEmailPreference`. Access is membership-gated.
 */
export const updateConversation = async (data: {
  id: string;
  teamId: string;
  userId: string;
  updates: { title: string };
}): Promise<SerializedConversation> => {
  const { id, teamId, userId, updates } = data;

  const existing = await getConversation({ id, teamId, userId });
  if (!existing) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  await db
    .update(aiConversations)
    .set({ title: updates.title })
    .where(eq(aiConversations.id, id));

  return { ...existing, title: updates.title };
};
