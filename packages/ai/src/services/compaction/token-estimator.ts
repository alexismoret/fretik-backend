import type { UIMessage } from "ai";

/**
 * Cheap chars/4 token heuristic. The BPE tokenisers used by most upstream
 * models (cl100k_base, o200k_base, MiniMax tokenizer) land in a narrow band
 * around 3.5-4 chars per token for English and 2.5-3 for dense CJK text. We
 * use 4 as a conservative ceiling — slightly over-estimates English, mildly
 * under-estimates CJK, which is the right bias for a compaction threshold:
 * kicks in a hair earlier than the true token count rather than later.
 *
 * Same heuristic Anthropic uses internally
 * (`claude-code/src/utils/tokens.ts`) and what every other `CHEAP_MODEL`
 * consumer implicitly assumes when sizing a prompt.
 */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

/**
 * Rough token count for a `UIMessage[]`. Serialises the whole array via
 * `JSON.stringify` and feeds the result through `estimateTokens`. This
 * handles text parts, tool-call parts, reasoning parts, and future part
 * kinds uniformly without enumerating the discriminated union — the JSON
 * envelope (quotes, braces, keys) slightly inflates the byte count vs the
 * actual prompt, which reinforces the "fire a bit earlier than needed"
 * bias mentioned above.
 *
 * Returns 0 on the (theoretical) case where serialisation throws — e.g.
 * circular refs. Messages reaching this layer come from the DB (`parts` is
 * JSONB) or from the AI SDK's own `convertToModelMessages` input, so this
 * is defensive, never actually hit.
 */
export const estimateMessagesTokens = (messages: UIMessage[]): number => {
  try {
    return estimateTokens(JSON.stringify(messages));
  } catch {
    return 0;
  }
};
