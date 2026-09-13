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
 * type — the caller's own pinned ones first, then most-recently-active. Each
 * row is serialised with its full member roster and the user's own
 * per-conversation state (pinned, unread, email opt-in, …). The exact total is
 * counted through the membership join so pagination metadata stays correct.
 *
 * The pin ordering is done HERE rather than in the client: the list is
 * paginated, so a client-side sort would only float the pins that happen to be
 * on the page it already holds.
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
      // A correlated subquery rather than an ordering on the joined member
      // row: `members` is a to-many relation here (a conversation has several
      // participants), so ordering on it would need the CALLER's row picked
      // out of the collection, which the relational builder cannot express.
      // NULLS LAST is load-bearing — Postgres sorts NULLs FIRST under DESC,
      // which would put every unpinned conversation above the pinned ones.
      orderBy: (conversation, { sql, desc }) => [
        sql`(SELECT m.pinned_at
             FROM ai_conversation_members m
             WHERE m.conversation_id = ${conversation.id}
               AND m.user_id = ${userId}) DESC NULLS LAST`,
        desc(conversation.updatedAt),
      ],
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
