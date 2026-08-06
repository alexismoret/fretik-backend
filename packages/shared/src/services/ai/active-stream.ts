import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { aiConversations } from "../../db/schema";

/**
 * Mark a conversation as having an active resumable stream. Called by the
 * chatbot POST /stream handler right before it starts streaming.
 *
 * Uses a conditional WHERE so we only succeed if no stream is already in
 * flight for this conversation — this is the backbone of the 409
 * idempotence guard in the POST handler. Returns true if the row was
 * updated, false if another turn beat us to it.
 */
export const setConversationActiveStream = async (
  conversationId: string,
  streamId: string,
): Promise<boolean> => {
  const rows = await db
    .update(aiConversations)
    .set({ activeStreamId: streamId })
    .where(
      and(
        eq(aiConversations.id, conversationId),
        isNull(aiConversations.activeStreamId),
      ),
    )
    .returning({ id: aiConversations.id });
  return rows.length > 0;
};

/**
 * Unconditionally point a conversation at a new stream. Workflow turns use
 * this instead of the CAS claim: turn serialization is already guaranteed
 * upstream (the Trigger orchestrator runs one turn at a time per run, and
 * replays are absorbed by the turn-index idempotency), so a stale id left
 * behind by a crashed process must never block the next turn's live
 * transcript the way the chat's 409 guard would.
 */
export const forceSetConversationActiveStream = async (
  conversationId: string,
  streamId: string,
): Promise<void> => {
  await db
    .update(aiConversations)
    .set({ activeStreamId: streamId })
    .where(eq(aiConversations.id, conversationId));
};

/**
 * Clear the active stream id, but only if it still matches the id that we
 * originally set. This compare-and-swap protects us against a stale
 * `onFinish` clearing a stream that was started by a later turn (e.g. if
 * the client fired two POST /stream calls before the first finished — not
 * expected, but this guard keeps the invariant airtight).
 */
export const clearConversationActiveStream = async (
  conversationId: string,
  streamId: string,
): Promise<void> => {
  await db
    .update(aiConversations)
    .set({ activeStreamId: null })
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.activeStreamId, streamId),
      ),
    );
};

/**
 * Read the currently-active stream id for a conversation. Used by the
 * GET /:conversationId/stream reconnection handler.
 */
export const getConversationActiveStream = async (
  conversationId: string,
): Promise<string | null> => {
  const row = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: { activeStreamId: true },
  });
  return row?.activeStreamId ?? null;
};
