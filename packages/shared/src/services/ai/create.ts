import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import type { AiAgentType } from "../../schemas/ai";
import type { SerializedConversation } from "./conversation-serializer";
import { getConversation } from "./get";

/**
 * Create a conversation and seat its creator as the sole `owner`. The owner's
 * `lastReadAt` is stamped now so their brand-new conversation never shows up
 * as unread to themselves. Further participants join later through
 * `addConversationMembers` (the single, validated add path).
 */
export const createConversation = async (data: {
  organizationId: string;
  teamId: string;
  userId: string;
  title: string;
  agentType?: AiAgentType;
}): Promise<SerializedConversation> => {
  const { organizationId, teamId, userId, title, agentType } = data;

  const conversationId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(aiConversations)
      .values({
        organizationId,
        teamId,
        userId,
        title,
        agentType: agentType ?? "chatbot",
      })
      .returning({ id: aiConversations.id });

    if (!row) throw new Error("Failed to create conversation");

    await tx.insert(aiConversationMembers).values({
      conversationId: row.id,
      userId,
      role: "owner",
      lastReadAt: new Date(),
    });

    return row.id;
  });

  // Re-read through the shared serialiser so create returns the exact same
  // shape as get/list — membership is guaranteed by the insert above.
  const serialized = await getConversation({
    id: conversationId,
    teamId,
    userId,
  });
  return serialized!;
};
