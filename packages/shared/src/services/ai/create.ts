import db from "../../db";
import { aiConversations } from "../../db/schema";
import type { AiAgentType } from "../../schemas/ai";

export const createConversation = async (data: {
  organizationId: string;
  teamId: string;
  userId: string;
  title: string;
  agentType?: AiAgentType;
}) => {
  const [row] = await db
    .insert(aiConversations)
    .values({
      organizationId: data.organizationId,
      teamId: data.teamId,
      userId: data.userId,
      title: data.title,
      agentType: data.agentType ?? "chatbot",
    })
    .returning();

  return row;
};
