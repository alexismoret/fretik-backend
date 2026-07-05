import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import type { AiAgentType } from "../../schemas/ai";
import { emitDomainEvent } from "../domain-events/emit";
import { getTeamAiSettings } from "../team-ai-settings/get-for-team";
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
   * Flagship model the user picked for this conversation (chantier C8).
   * Stamped here and immutable thereafter. Null/undefined → resolved from
   * the team default (or code default) lazily on the first turn. Validation
   * is authoritative at resolution time in `@fretik/ai`.
   */
  modelProfileKey?: string;
}): Promise<SerializedConversation> => {
  const { organizationId, teamId, userId, title, agentType, modelProfileKey } =
    data;

  // Pin the flagship model at creation: explicit picker choice → team
  // default → null (code default, resolved per turn in @fretik/ai). Reading
  // the team default is a plain key lookup — registry validation happens
  // authoritatively at resolution time, where an invalid key falls back.
  const pinnedProfileKey =
    modelProfileKey ??
    (await getTeamAiSettings(teamId))?.flagshipProfileKey ??
    null;

  const conversationId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(aiConversations)
      .values({
        organizationId,
        teamId,
        userId,
        title,
        agentType: agentType ?? "chatbot",
        modelProfileKey: pinnedProfileKey,
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
