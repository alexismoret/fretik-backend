import { and, eq, ne, sql } from "drizzle-orm";
import db from "../../db";
import type { ConversationTaskMetadata } from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";
import { mergeTaskMetadata } from "./metadata-merge";

/**
 * What a conversation's sub-agents spent, in the units a workflow run budgets.
 *
 * A sub-agent runs on a queue worker, outside the turn that launched it, so
 * its spend reaches the launching run only through its task row
 * (`subAgent.usage`, live while it runs, final once settled). A run folds it
 * into its own total exactly once: claiming a settled row stamps it `billed`
 * in the same UPDATE that reads it, so a replayed turn or two racing readers
 * never count one run twice.
 */
export interface SubAgentSpend {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export const sumSubAgentSpend = (
  rows: readonly { metadata: ConversationTaskMetadata | null }[],
): SubAgentSpend =>
  rows.reduce<SubAgentSpend>(
    (sum, row) => {
      const usage = row.metadata?.subAgent?.usage;
      return {
        inputTokens: sum.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (usage?.outputTokens ?? 0),
        cacheReadTokens: sum.cacheReadTokens + (usage?.cacheReadTokens ?? 0),
      };
    },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  );

export const notBilled = sql`coalesce((${conversationBackgroundTasks.metadata} -> 'subAgent' ->> 'billed')::boolean, false) = false`;

/**
 * Claim the spend of every SETTLED sub-agent of the conversation not billed
 * yet. A running one is left for the claim after it settles.
 */
export const claimSubAgentSpend = async (
  conversationId: string,
): Promise<SubAgentSpend> => {
  const rows = await db
    .update(conversationBackgroundTasks)
    .set({ metadata: mergeTaskMetadata({ subAgent: { billed: true } }) })
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        ne(conversationBackgroundTasks.status, "pending"),
        notBilled,
      ),
    )
    .returning({ metadata: conversationBackgroundTasks.metadata });
  return sumSubAgentSpend(rows);
};
