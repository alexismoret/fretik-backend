import type { ModelMessage } from "ai";

/**
 * What a prompt renderer produces once the volatile half stops travelling in
 * the system message.
 *
 * `turnContext` is absent for every agent whose whole prompt is stable for the
 * span it runs over — the workflow executor (byte-stable per run), the
 * delegates and the page builder (one call each). Absent, not empty: an agent
 * that HAS a block and rendered it to nothing is the same case as one that has
 * none, and neither should put an empty part on the wire.
 */
export interface RenderedAgentPrompt {
  /** The system message. */
  instructions: string;
  /** The block that rides the latest user message. */
  turnContext?: string;
}

/**
 * Attach the turn-volatile half of the prompt to the END of the conversation,
 * instead of to the front of it.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every provider our fleet routes to caches an IMPLICIT prefix: it keeps the
 * longest byte-identical head of the request it has already seen. So the first
 * byte that differs from the previous turn decides how much of the turn is
 * cached — everything after it is re-read at full price.
 *
 * The blocks that change every turn (the clock, what recall matched, which
 * domain tools are unlocked) used to sit in the SYSTEM message, which is the
 * front of the request. One changed byte there and the entire history behind
 * it — 50k, 100k tokens of it — fell out of cache. Measured over seven days of
 * production traffic: at a turn boundary with the same provider and under two
 * minutes elapsed, the cache returned **30 %** of the previous turn's input,
 * against 81 % between steps WITHIN a turn. `cacheRead` sat frozen at a
 * constant (26 880, then 31 360) while input climbed from 50k to 100k — the
 * signature of a prefix that stops at a fixed offset.
 *
 * Moving that block behind the history inverts the arithmetic. Turn N sends
 * `S + H + U_N + B_N`; turn N+1 sends `S + H + U_N + A_N + U_{N+1} + B_{N+1}`,
 * where `B` is this block and `A_N` is turn N's answer. The common prefix is
 * `S + H + U_N` — everything except the previous answer. Putting `B` anywhere
 * earlier costs whatever follows it.
 *
 * ── Why a PART on the last user message, not a message of its own ──────────
 *
 * Two reasons, both about not moving bytes that do not need to move.
 * Appending a part leaves the message COUNT unchanged, so
 * `selectBreakpointIndices` (`lib/openrouter-cache.ts`) picks the same anchors
 * it picked before — it selects by index and role, and a new trailing message
 * shifts every one of them. And consecutive user messages are normalised
 * differently by different upstreams (some merge them, some do not), which is
 * a byte difference we would be introducing for nothing.
 *
 * Pushing a message is the fallback for when the last message is NOT a user
 * one — a continuation resumed at a turn boundary can end on an assistant or
 * tool message, and a block appended to a tool result is a block the model
 * reads as output of its own call.
 *
 * ── Why it is NEVER persisted ──────────────────────────────────────────────
 *
 * The caller applies this to the in-memory array only; the history in the
 * database never carries it. Persisting would cover `A_N` as well — a slightly
 * longer cached prefix — and cost far more than it buys: at ~2-3k tokens a
 * turn over 30 turns, 60-90k tokens of expired recall installed permanently,
 * ahead of the compaction threshold, with the model reading turn 3's recall
 * while it answers turn 30.
 *
 * ── The boundary this blurs, stated plainly ────────────────────────────────
 *
 * A user message is untrusted input; this block is not. Appending it to the
 * user's turn means a user CAN type the delimiter and forge a block. What that
 * buys an attacker is close to nothing here — they are an authenticated member
 * of the team whose memory it is, and the `memory` tool already lets them
 * write it for real — and the forgery lands BEFORE the genuine block, which is
 * appended last. The injection surface that matters (content arriving from a
 * document or a web page) reaches the model through tool results and is
 * unchanged by this.
 */
export const appendTurnContext = (
  messages: readonly ModelMessage[],
  block: string,
): ModelMessage[] => {
  const trimmed = block.trim();
  if (trimmed.length === 0) return [...messages];

  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "user") {
    return [...messages, { role: "user", content: trimmed }];
  }

  // A user message's content is either a bare string or an array of parts.
  // Normalising the string form into a part keeps ONE shape on the wire
  // whichever way the caller built the history.
  const parts =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : [...last.content];

  return [
    ...messages.slice(0, -1),
    { ...last, content: [...parts, { type: "text" as const, text: trimmed }] },
  ];
};
