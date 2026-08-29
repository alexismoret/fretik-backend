import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import type { AiAgentType } from "../../schemas/ai";
import { emitDomainEvent } from "../domain-events/emit";
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
  /**
   * EXPLICIT flagship pin for this conversation — nothing else. A caller
   * that omits it leaves the column null, and every turn then resolves the
   * TEAM's current pick (`resolveTeamFlagship`, @fretik/ai).
   *
   * It used to default to the team's key at creation time, which read as an
   * explicit pin forever after: a team that later changed its model kept
   * serving the old one to every conversation opened before the change,
   * silently and with no way back. Only a caller that means "this
   * conversation, this model, regardless of the team" passes a key.
   */
  modelProfileKey?: string;
}): Promise<SerializedConversation> => {
  const { organizationId, teamId, userId, title, agentType, modelProfileKey } =
    data;

  const conversationId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(aiConversations)
      .values({
        organizationId,
        teamId,
        userId,
        title,
        agentType: agentType ?? "chatbot",
        modelProfileKey: modelProfileKey ?? null,
      })
      .returning({ id: aiConversations.id });

    if (!row) throw new Error("Failed to create conversation");

    await tx.insert(aiConversationMembers).values({
      conversationId: row.id,
      userId,
      role: "owner",
      lastReadAt: new Date(),
    });

    // The id goes in the payload — the event's own conversation FK column is
    // set-null on delete, the payload survives.
    await emitDomainEvent({
      tx,
      organizationId,
      teamId,
      type: "conversation.created",
      actor: { actorType: "user", actorUserId: userId },
      subjectType: "conversation",
      payload: { conversationId: row.id, agentType: agentType ?? "chatbot" },
      dedupKey: `conversation.created:${row.id}`,
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
