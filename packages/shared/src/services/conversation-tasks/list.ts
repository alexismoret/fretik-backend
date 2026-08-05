import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import db from "../../db";
import type { ConversationBackgroundTask } from "../../db/schema";
import {
  CONVERSATION_TASK_TERMINAL_STATUSES,
  conversationBackgroundTasks,
} from "../../db/schema";

/** How far back a settled task still shows in the conversation's task list. */
const RECENT_WINDOW_MS = 60 * 60 * 1000;

/** Tasks this conversation is still waiting on. */
export const listPendingConversationTasks = async (
  conversationId: string,
): Promise<ConversationBackgroundTask[]> =>
  db
    .select()
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        eq(conversationBackgroundTasks.status, "pending"),
      ),
    )
    .orderBy(desc(conversationBackgroundTasks.createdAt));

/**
 * What the conversation's task strip shows: everything still running, plus
 * what settled recently so a run that just finished doesn't vanish from the
 * UI the instant it completes.
 */
export const listConversationTasks = async (
  conversationId: string,
): Promise<ConversationBackgroundTask[]> =>
  db
    .select()
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        or(
          eq(conversationBackgroundTasks.status, "pending"),
          gte(
            conversationBackgroundTasks.completedAt,
            new Date(Date.now() - RECENT_WINDOW_MS),
          ),
        ),
      ),
    )
    .orderBy(desc(conversationBackgroundTasks.createdAt));

/**
 * Whether a resume is owed: something settled, nothing left running. Cheap
 * pre-check ahead of the claiming UPDATE, which is the authority.
 */
export const hasResumableConversationTasks = async (
  conversationId: string,
): Promise<boolean> => {
  const rows = await db
    .select({
      status: conversationBackgroundTasks.status,
      consumedAt: conversationBackgroundTasks.consumedAt,
    })
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        or(
          eq(conversationBackgroundTasks.status, "pending"),
          and(
            inArray(conversationBackgroundTasks.status, [
              ...CONVERSATION_TASK_TERMINAL_STATUSES,
            ]),
            isNull(conversationBackgroundTasks.consumedAt),
          ),
        ),
      ),
    );

  if (rows.length === 0) return false;
  return rows.every((row) => row.status !== "pending");
};
