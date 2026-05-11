import type { UIMessage } from "ai";

/**
 * Group a `UIMessage[]` into "API rounds": one user message followed
 * by every subsequent assistant / tool message until the next user
 * turn. Mirrors `claude-code/src/services/compact/grouping.ts::
 * groupMessagesByApiRound`.
 *
 * Used exclusively by the prompt-too-long retry loop in `summarizer.ts`:
 * when the summariser model returns a context-overflow error (the
 * older block we asked it to summarise is bigger than its own context
 * window), we drop the oldest 20% of API rounds and retry. Grouping
 * by round (rather than raw message count) keeps user-question +
 * assistant-answer pairs together so the summary doesn't lose the
 * question that motivated a tool result.
 *
 * Edge cases:
 *   - Leading messages without a preceding user (e.g. system / a
 *     stray assistant) form their own initial group. Defensive: never
 *     drops a message silently.
 *   - A trailing user message with no assistant reply yet is still
 *     its own group.
 *   - Empty input → empty array.
 */
export const groupMessagesByApiRound = (
  messages: UIMessage[],
): UIMessage[][] => {
  if (messages.length === 0) return [];
  const groups: UIMessage[][] = [];
  let current: UIMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (current.length > 0) {
        groups.push(current);
      }
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
};

/**
 * Drop the oldest `dropFraction` of API rounds (rounded up) and return
 * the surviving messages flattened back into a `UIMessage[]`. Used by
 * the PTL retry loop — caller passes the messages that overflowed,
 * we return a smaller slice to retry on.
 *
 * `dropFraction` is clamped to `(0, 1)` — outside the open interval
 * the caller is asking for either a no-op or a full clear, both
 * almost certainly bugs. We never drop ALL rounds (would leave the
 * summariser with nothing to summarise and trigger a different
 * failure mode).
 *
 * @returns flattened messages after dropping oldest groups, plus the
 *   number of rounds actually dropped (for logging).
 */
export const dropOldestRounds = (
  messages: UIMessage[],
  dropFraction: number,
): { messages: UIMessage[]; droppedRounds: number } => {
  if (messages.length === 0) {
    return { messages, droppedRounds: 0 };
  }
  const fraction = Math.min(0.9, Math.max(0.05, dropFraction));
  const groups = groupMessagesByApiRound(messages);
  if (groups.length <= 1) {
    return { messages, droppedRounds: 0 };
  }
  const toDrop = Math.max(1, Math.ceil(groups.length * fraction));
  // Never leave fewer than 1 group — the caller still needs SOMETHING
  // to send to the summariser. If toDrop would empty the array, cap
  // it to `groups.length - 1`.
  const safeDrop = Math.min(toDrop, groups.length - 1);
  const survivors = groups.slice(safeDrop).flat();
  return { messages: survivors, droppedRounds: safeDrop };
};
