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

/**
 * Background sub-agents whose outcome the agent has not read yet: still
 * running, or settled and not yet handed over (by a resume or `checkAgents`).
 * Oldest first — the order they were launched in.
 */
export const listOpenSubAgentTasks = async (
  conversationId: string,
): Promise<ConversationBackgroundTask[]> =>
  db
    .select()
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        or(
          eq(conversationBackgroundTasks.status, "pending"),
          isNull(conversationBackgroundTasks.consumedAt),
        ),
      ),
    )
    .orderBy(conversationBackgroundTasks.createdAt);

/**
 * Specific background sub-agents of one conversation, by id — what a chat card
 * asks for. Scoped to the conversation so an id from another one reads as
 * absent, whatever the caller passes.
 */
export const listSubAgentTasks = async (
  conversationId: string,
  agentIds: readonly string[],
): Promise<ConversationBackgroundTask[]> => {
  if (agentIds.length === 0) return [];
  return db
    .select()
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        inArray(conversationBackgroundTasks.ref, [...agentIds]),
      ),
    );
};

/**
 * Whether a background sub-agent of this conversation is still running — the
 * turn-end sandbox pause must not freeze its Python cell mid-run.
 */
export const hasRunningSubAgentTasks = async (
  conversationId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: conversationBackgroundTasks.id })
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, conversationId),
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        eq(conversationBackgroundTasks.status, "pending"),
      ),
    )
    .limit(1);
  return rows.length > 0;
};
