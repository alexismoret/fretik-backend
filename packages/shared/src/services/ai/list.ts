import { and, count, eq, ilike, type SQL } from "drizzle-orm";
import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import type { AiAgentType } from "../../schemas/ai";
import type { ParamsList } from "../../schemas/common/params";
import {
  conversationWith,
  serializeConversation,
  type SerializedConversation,
} from "./conversation-serializer";

/**
 * List the conversations the current user participates in for a given agent
 * type, most-recently-active first. Each row is serialised with its full
 * member roster and the user's own per-conversation state (unread, email
 * opt-in, …). The exact total is counted through the membership join so
 * pagination metadata stays correct.
 */
export const listConversations = async (data: {
  teamId: string;
  userId: string;
  agentType: AiAgentType;
  params: ParamsList;
}): Promise<{ count: number; data: SerializedConversation[] }> => {
  const { teamId, userId, agentType, params } = data;
  const { limit, page, search } = params;

  const [rows, totalRows] = await Promise.all([
    db.query.aiConversations.findMany({
      where: {
        teamId,
        agentType,
        members: { userId },
        ...(search ? { title: { ilike: `%${search}%` } } : {}),
      },
      with: conversationWith,
      orderBy: { updatedAt: "desc" },
      limit,
      offset: page * limit,
    }),
    countUserConversations({ teamId, userId, agentType, search }),
  ]);

  return {
    count: totalRows,
    data: rows.map((row) => serializeConversation(row, userId)),
  };
};

/**
 * Exact count of the user's conversations via the membership join — the
 * relational query above can't return a total alongside a paginated page.
 */
const countUserConversations = async (data: {
  teamId: string;
  userId: string;
  agentType: AiAgentType;
  search?: string;
}): Promise<number> => {
  const { teamId, userId, agentType, search } = data;

  const conditions: SQL[] = [
    eq(aiConversations.teamId, teamId),
    eq(aiConversations.agentType, agentType),
    eq(aiConversationMembers.userId, userId),
  ];
  if (search) conditions.push(ilike(aiConversations.title, `%${search}%`));

  const [row] = await db
    .select({ count: count() })
    .from(aiConversations)
    .innerJoin(
      aiConversationMembers,
      eq(aiConversationMembers.conversationId, aiConversations.id),
    )
    .where(and(...conditions));

  return row?.count ?? 0;
};
