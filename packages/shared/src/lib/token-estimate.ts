import { encode } from "gpt-tokenizer/encoding/o200k_base";

/**
 * The one place tokens are counted, and it counts them for real.
 *
 * ## What was here before, and why it had to go
 *
 * `Math.ceil(text.length / 4)`. Four copies of it had grown across the
 * codebase — the compaction threshold, the page-history prune valve, the
 * AI-context budget, the agent context ceiling — and consolidating them fixed
 * the duplication while leaving the number wrong. Measured 2026-09-18 against
 * `o200k_base` on the content this system actually carries:
 *
 * | content                          |   chars | `chars/4` |    real | ratio |
 * | -------------------------------- | ------: | --------: | ------: | ----: |
 * | tool output (CSV rows, JSON)     | 167 294 |    41 824 |  80 253 |  1.92 |
 * | tool output, larger              | 486 388 |   121 597 | 236 920 |  1.95 |
 * | tool output, larger still        | 1.36 M  |   340 739 | 666 861 |  1.96 |
 * | French prose                     | 312 000 |    78 000 |  68 001 |  0.87 |
 *
 * So the heuristic UNDER-counted structured text by a factor of two and
 * OVER-counted prose by 15 % — a 2.2× spread between two kinds of content that
 * sit in the same conversation. No single divisor serves both, which is why
 * this is not a tuned constant any more. The measured consequence of the
 * under-count, on a real workflow run: compaction read its own number, called a
 * 118 414-token history "65 018", declined to act, and four consecutive turns
 * then died on arrival at the context ceiling.
 *
 * ## Why `o200k_base`
 *
 * It is the encoder behind the current OpenAI models, published and stable, and
 * the closest widely-available BPE to what the families we serve use. It is NOT
 * exact for DeepSeek, Claude or Gemini — each ships its own vocabulary, and the
 * spread across families is on the order of ±15 %. That residual is handled
 * where it matters rather than guessed at here: the context ceiling takes
 * `max(provider-reported, counted)`, so a family that tokenises denser than
 * o200k is caught by its own report, and `observeTokenRatio` records what the
 * gap actually is per model instead of assuming it.
 *
 * ## Why it counts in slices — this one is not an optimisation
 *
 * A BPE encoder splits text into words first and then merges INSIDE each word,
 * and that inner merge is quadratic. Ordinary text never notices because words
 * are short. A run of one repeated character is a single enormous "word", and
 * the curve is brutal (measured 2026-09-18, `o200k_base`):
 *
 * | input               | one call |  in slices |
 * | ------------------- | -------: | ---------: |
 * | `"x"` × 32 000      |   453 ms |          — |
 * | `"x"` × 100 000     | 5 407 ms |          — |
 * | `"x"` × 300 000     |  52 638 ms |      14 ms |
 * | `"x"` × 600 000     | ~188 000 ms |       1 ms |
 *
 * Fifty-two seconds of blocked event loop for 300 KB, and tool output is full
 * of repetition — separators, padding, identical log lines, a column of zeros.
 * Adopting a real tokeniser without this would have traded a wrong number for
 * an outage. Slicing bounds the worst case at the cost of splitting a token in
 * two at each boundary: measured at +0.08 % on prose and +0.03 % on JSON, and
 * always UPWARD, which is the direction a context budget wants to be wrong in.
 *
 * ## Cost, and the cache
 *
 * Even sliced, counting is real work: ~11 ms for 200 KB of prose. A turn that
 * recounted its whole window on every step would pay that thirty times over, so
 * `countCachedTokens` memoises per unit of content. The natural unit is one
 * message: messages are immutable once settled, a window is 30 of them, and a
 * turn adds one or two — so a steady-state turn tokenises what is new and reads
 * the rest from the map.
 */

/**
 * Cheap sizing ratio, for nominal targets and displayed figures only — NEVER as
 * a token count that a context budget depends on. The table above is the
 * argument: at 4 it is wrong in both directions depending on the content.
 *
 * Three callers keep it, and each keeps it for a stated reason rather than by
 * omission:
 *
 *  - `evals/history.ts` sizes a generated history to a nominal target. It wants
 *    a stable ruler, not a measurement.
 *  - `services/ai-context/retrieve.ts` has only per-file character counts by the
 *    time it reports a figure — the texts are gone — and that figure is shown in
 *    the settings UI, never decided on.
 *  - `services/page-project/prune-history.ts` deliberately wants to be LATE.
 *    Page-builder history is code, which this under-counts, so the valve opens
 *    later than an exact count would open it. Opening it earlier is a behaviour
 *    that was measured and undone, so correcting the number there is an eval, not
 *    a refactor.
 */
export const CHARS_PER_TOKEN = 4;

/** Entries are one number each; the bound is about unbounded growth, not size. */
const CACHE_MAX_ENTRIES = 4_096;

const cache = new Map<string, number>();

/**
 * Slice width. Small enough that the quadratic inner loop cannot run away,
 * large enough that boundary splits stay in the per-mille range.
 */
const SLICE_CHARS = 8_000;

/** Count tokens. Exact for `o200k_base`, approximate across families. */
export const countTokens = (text: string): number => {
  if (text.length === 0) return 0;
  if (text.length <= SLICE_CHARS) return encode(text).length;
  let total = 0;
  for (let at = 0; at < text.length; at += SLICE_CHARS) {
    total += encode(text.slice(at, at + SLICE_CHARS)).length;
  }
  return total;
};

/**
 * Count tokens, memoised on the content itself.
 *
 * Keyed by `Bun.hash` of the text — a process-local memo, never persisted, so
 * the rule against `Bun.hash` for stored identifiers does not apply: nothing
 * survives the process and a hash collision costs a slightly wrong count on one
 * message, not a wrong row.
 */
export const countCachedTokens = (text: string): number => {
  if (text.length === 0) return 0;
  const key = Bun.hash(text).toString();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const counted = countTokens(text);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Oldest first — `Map` iterates in insertion order, and the working set is
    // one conversation window, far under the bound.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, counted);
  return counted;
};

/**
 * Historical name, kept so the four call sites did not all have to change in
 * the same commit. Same counter.
 */
export const estimateTokens = (text: string): number => countCachedTokens(text);
