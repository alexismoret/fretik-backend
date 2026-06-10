import type { UIMessage } from "ai";
import db from "../../db";
import { loadMessagesBefore, loadMessagesSince } from "./messages";

/** How many already-read messages to include as grounding context. */
const PRIOR_CONTEXT_LIMIT = 8;

export type CatchUpContext = {
  /** A short window of already-read messages, for grounding the summary. */
  priorContext: UIMessage[];
  /** The messages the member hasn't seen yet — the focus of the summary. */
  missed: UIMessage[];
};

/**
 * Build the catch-up context for a member: the messages they haven't seen
 * (everything after the read marker) plus a small window of the messages just
 * before it (to ground the summariser without re-feeding the whole thread).
 *
 * `since` lets the caller pin the marker explicitly. The client captures the
 * member's `lastReadAt` when the conversation opens and passes it here, so the
 * catch-up still works even though opening the conversation marks it read
 * (which would otherwise advance `lastReadAt` to now). Falls back to the
 * stored `lastReadAt` / `joinedAt` when omitted. Empty arrays for non-members.
 */
export const loadCatchUpContext = async (data: {
  conversationId: string;
  userId: string;
  since?: Date;
}): Promise<CatchUpContext> => {
  const { conversationId, userId, since } = data;

  let marker = since;
  if (!marker) {
    const member = await db.query.aiConversationMembers.findFirst({
      where: { conversationId, userId },
      columns: { lastReadAt: true, joinedAt: true },
    });
    if (!member) return { priorContext: [], missed: [] };
    marker = member.lastReadAt ?? member.joinedAt;
  }

  const [priorContext, missed] = await Promise.all([
    loadMessagesBefore(conversationId, marker, PRIOR_CONTEXT_LIMIT),
    loadMessagesSince(conversationId, marker),
  ]);

  return { priorContext, missed };
};
