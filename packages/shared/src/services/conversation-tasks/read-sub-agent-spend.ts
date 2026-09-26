import { and, eq } from "drizzle-orm";
import db from "../../db";
import { conversationBackgroundTasks } from "../../db/schema";
import {
  notBilled,
  type SubAgentSpend,
  sumSubAgentSpend,
} from "./claim-sub-agent-spend";

/**
 * What the conversation's sub-agents have spent that no run total holds yet:
 * the live figure of those still running, the final one of those settled and
 * not claimed. A read, for a budget check between two steps — the fold into
 * the run's total is `claimSubAgentSpend`.
 */
export const readUnbilledSubAgentSpend = async (
  conversationId: string,
): Promise<SubAgentSpend> => {
  const rows = await db
    .select({ metadata: conversationBackgroundTasks.metadata })
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        notBilled,
      ),
    );
  return sumSubAgentSpend(rows);
};
