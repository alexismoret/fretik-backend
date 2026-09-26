import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import type { SubAgentStopper } from "../../db/schema";
import { conversationBackgroundTasks } from "../../db/schema";
import { publishSubAgentAbort } from "../../lib/sub-agent-abort";
import { mergeTaskMetadata } from "./metadata-merge";

/**
 * Ask running sub-agents of a conversation to stop — named ones, every one a
 * given turn launched (the user stopped that answer), or all of them (the
 * workflow run they worked for is over).
 *
 * Two writes, for the two states a run can be in: the request is recorded on
 * the task row, which a run still waiting in the queue reads when a worker
 * picks it up, and published on the run's abort channel, which a run already
 * working hears at once. Only the running process settles the row (as
 * `canceled`, with what it had done), so this never races it to a terminal
 * status. Scoped to the conversation, and to PENDING rows: stopping something
 * that already finished is a no-op, not an error.
 *
 * Returns the ids actually asked — the ones that were still running.
 */
export const requestSubAgentStop = async (params: {
  conversationId: string;
  by: SubAgentStopper;
  agentIds?: readonly string[];
  /** Every sub-agent launched by this turn (root trace id). */
  turnId?: string;
  /** Every running sub-agent of the conversation. */
  all?: true;
}): Promise<string[]> => {
  if (params.agentIds !== undefined && params.agentIds.length === 0) return [];
  const scope =
    params.agentIds !== undefined
      ? inArray(conversationBackgroundTasks.ref, [...params.agentIds])
      : params.turnId !== undefined
        ? sql`${conversationBackgroundTasks.metadata} -> 'subAgent' ->> 'turnId' = ${params.turnId}`
        : params.all === true
          ? undefined
          : null;
  if (scope === null) return [];

  const rows = await db
    .update(conversationBackgroundTasks)
    .set({
      metadata: mergeTaskMetadata({ subAgent: { stopRequested: params.by } }),
    })
    .where(
      and(
        eq(conversationBackgroundTasks.conversationId, params.conversationId),
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        eq(conversationBackgroundTasks.status, "pending"),
        // A second stop does not rename who asked first.
        sql`${conversationBackgroundTasks.metadata} -> 'subAgent' ->> 'stopRequested' IS NULL`,
        scope,
      ),
    )
    .returning({ ref: conversationBackgroundTasks.ref });

  await Promise.all(
    rows.map((row) => publishSubAgentAbort(row.ref, params.by)),
  );
  return rows.map((row) => row.ref);
};
