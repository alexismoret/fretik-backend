import { and, count, desc, eq, ilike, type SQL } from "drizzle-orm";
import db from "../../db";
import { aiConversations } from "../../db/schema";
import type { AiAgentType } from "../../schemas/ai";
import type { ParamsList } from "../../schemas/common/params";

export const listConversations = async (data: {
  teamId: string;
  userId: string;
  agentType: AiAgentType;
  params: ParamsList;
}) => {
  const { teamId, userId, agentType, params } = data;
  const { limit, page, search } = params;

  const conditions: SQL[] = [
    eq(aiConversations.teamId, teamId),
    eq(aiConversations.userId, userId),
    eq(aiConversations.agentType, agentType),
  ];

  if (search) {
    conditions.push(ilike(aiConversations.title, `%${search}%`));
  }

  const whereClause = and(...conditions)!;

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(aiConversations)
      .where(whereClause)
      .orderBy(desc(aiConversations.updatedAt))
      .limit(limit)
      .offset(page * limit),
    db.select({ count: count() }).from(aiConversations).where(whereClause),
  ]);

  return {
    count: totalRows[0]?.count ?? 0,
    data: rows,
  };
};
