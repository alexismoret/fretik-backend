/**
 * Milliseconds encoded in a UUID v7's leading 48-bit timestamp, or null when
 * the string is not a v7 UUID.
 *
 * Used to tell "this turn slot was claimed a moment ago, its stream buffer is
 * simply not registered yet" from "this slot is stale" — both look identical
 * (a claimed `activeStreamId` with no resumable buffer behind it) and the
 * right answer is opposite. Every stream id is minted with `randomUUIDv7`, so
 * the claim time is already in the value; nothing extra to store.
 *
 * Lives in shared (moved from @fretik/ai, which re-exports it) so the jobs
 * maintenance sweep can apply the same claim-age heuristic as the AI
 * service's stream endpoints.
 */
export const uuidv7TimestampMs = (id: string): number | null => {
  const hex = id.replaceAll("-", "");
  if (hex.length !== 32) return null;
  if (hex[12] !== "7") return null;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isNaN(ms) ? null : ms;
};
