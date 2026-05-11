import { type UIMessage, streamText } from "ai";
import { openrouter } from "../../lib/openrouter";
import { dropOldestRounds } from "./grouping";
import { formatCompactSummary, getCompactPrompt } from "./prompt";

/**
 * LLM-based summariser for the older portion of a chatbot conversation.
 *
 * Aligned with Claude Code's compaction pattern (`claude-code/src/
 * services/compact/compact.ts` + `prompt.ts`):
 *   - 9-section structured prompt with `<analysis>...<summary>` envelope
 *     (built in `./prompt.ts::getCompactPrompt`).
 *   - `streamText` rather than `generateText` so the work isn't lost
 *     when the HTTP connection slows: even if the abort signal fires
 *     after `result.text` resolves, we already have the final string
 *     in hand.
 *   - Prompt-too-long retry loop (CC pattern from `compact.ts:1180+`):
 *     when the summariser model returns a context-overflow error, drop
 *     the oldest 20% of API rounds and retry. Max 3 attempts.
 *   - Soft-fail: returns `null` on any non-recoverable failure so
 *     `compact.ts` can fall back to uncompacted history. Never throws.
 *
 * Output contract: returns the post-`formatCompactSummary` string
 * (analysis stripped, `<summary>` unwrapped) or `null`.
 *
 * @see ./prompt.ts
 * @see claude-code/src/services/compact/compact.ts
 */

const SUMMARISER_TEMPERATURE = 0.2;

/**
 * Compaction summariser model. Defaults to `deepseek/deepseek-v4-flash`
 * — 1M-token context window keeps very long older blocks within
 * reach, and the price-per-token is well below the previous default
 * (`gpt-oss-120b`) which capped us at 131K. Add `OPENROUTER_COMPACTION_MODEL`
 * to the chatbot service `.env` to override (useful when the team
 * wants to A/B against a different summariser without redeploying).
 *
 * Env override: `OPENROUTER_COMPACTION_MODEL`.
 */
const COMPACTION_MODEL_ID =
  process.env.OPENROUTER_COMPACTION_MODEL ?? "deepseek/deepseek-v4-flash";

/**
 * Upper bound on the summary length, aligned with Claude Code's
 * `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` (p99.99 observation was
 * 17.4K tokens). Bumped from the previous 8K because the 9-section
 * prompt produces longer summaries than the old 5-section prompt did.
 *
 * Env override: `COMPACTION_SUMMARIZER_MAX_TOKENS`, clamped
 * `[2_000, 32_000]`.
 */
export const SUMMARISER_MAX_TOKENS = (() => {
  const raw = process.env.COMPACTION_SUMMARIZER_MAX_TOKENS;
  if (!raw) return 20_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20_000;
  return Math.min(32_000, Math.max(2_000, Math.floor(parsed)));
})();

/**
 * Total wall-clock timeout for the summariser call. Bumped from 20s
 * (which was producing false aborts on 100K+ token inputs to
 * gpt-oss-120b — the model finished but the client-side abort fired
 * during the final HTTP read) to 90s. Coupled with `streamText`,
 * this comfortably covers worst-case TTFT + 20K-token output even
 * on cold OpenRouter routes.
 *
 * Env override: `COMPACTION_SUMMARIZER_TIMEOUT_MS`, clamped
 * `[10_000, 300_000]`.
 */
const SUMMARISER_TIMEOUT_MS = (() => {
  const raw = process.env.COMPACTION_SUMMARIZER_TIMEOUT_MS;
  if (!raw) return 90_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 90_000;
  return Math.min(300_000, Math.max(10_000, Math.floor(parsed)));
})();

/**
 * Maximum number of retries when the summariser request itself blows
 * the context window of the summariser model. Each retry drops the
 * oldest 20% of API rounds before re-submitting. After this many
 * attempts we soft-fail (return null).
 *
 * Mirrors CC's `MAX_PTL_RETRIES = 3` (`compact.ts:1180+`).
 */
const MAX_PTL_RETRIES = 3;
const PTL_DROP_FRACTION = 0.2;

const compactionModel = openrouter.chat(COMPACTION_MODEL_ID);

const PART_TOOL_PREFIX = "tool-";

/**
 * Flatten a `UIMessage` into plain text suitable for an LLM prompt.
 * - `text` parts → kept verbatim.
 * - `tool-<name>` parts in `output-available` state → flatten name +
 *   stringified output (so the summariser sees what the tool
 *   returned). Stringification is best-effort; circular refs would
 *   throw, in which case we fall back to a plain `[tool:<name>]`
 *   marker. The output is bounded by upstream `maxResultSizeChars`
 *   per tool plus the per-message persisted-output fence, so the
 *   serialised text stays within the summariser's input budget.
 * - Other parts (file, reasoning, source, step-start) are dropped —
 *   per-turn scaffolding adds noise without informational value.
 */
const extractMessageText = (message: UIMessage): string => {
  const fragments: string[] = [];
  for (const part of message.parts) {
    if (part === undefined || part === null || typeof part !== "object") {
      continue;
    }
    if (!("type" in part) || typeof part.type !== "string") continue;
    if (
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      fragments.push(part.text);
      continue;
    }
    if (part.type.startsWith(PART_TOOL_PREFIX)) {
      const toolName = part.type.slice(PART_TOOL_PREFIX.length) || "unknown";
      if (
        "state" in part &&
        part.state === "output-available" &&
        "output" in part
      ) {
        const out = part.output;
        let serialised: string;
        try {
          serialised = typeof out === "string" ? out : JSON.stringify(out);
        } catch {
          serialised = `[tool:${toolName} <unserialisable output>]`;
        }
        fragments.push(`[tool:${toolName}]\n${serialised}`);
      } else {
        fragments.push(`[tool:${toolName}]`);
      }
    }
  }
  return fragments.join("\n").trim();
};

const serialiseMessages = (messages: UIMessage[]): string =>
  messages
    .map((m) => {
      const body = extractMessageText(m);
      return body.length > 0 ? `[${m.role}] ${body}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n\n");

const buildPrompt = (messages: UIMessage[]): string =>
  `${getCompactPrompt()}

Conversation to summarise (each block prefixed by its role):

${serialiseMessages(messages)}`;

/**
 * Heuristic check: does this error look like a context-length /
 * prompt-too-long error from the summariser provider? Different
 * providers word it differently:
 *   - OpenRouter (forwarded from upstream): typically a 400 with
 *     `"context_length_exceeded"` or `"prompt is too long"`.
 *   - DeepSeek native: `"This model's maximum context length is..."`.
 *   - Anthropic via OpenRouter: `"prompt is too long"`.
 *
 * We match a generous case-insensitive pattern against the message;
 * misclassification is benign — at worst we'd consume one PTL retry
 * unnecessarily on a non-PTL error, which is bounded by
 * `MAX_PTL_RETRIES`.
 */
const looksLikeContextOverflow = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /context.{0,40}(length|window)|prompt.{0,20}too.{0,20}long|maximum.{0,20}context/i.test(
    msg,
  );
};

/**
 * Run a single summariser invocation. Used internally by
 * `summariseMessages` for both the initial attempt and PTL retries.
 *
 * Throws on context-length errors so the outer loop can decide
 * whether to retry. All other errors are caught here and surface
 * as `null`.
 */
const runSummariser = async (messages: UIMessage[]): Promise<string | null> => {
  const result = streamText({
    model: compactionModel,
    prompt: buildPrompt(messages),
    temperature: SUMMARISER_TEMPERATURE,
    maxOutputTokens: SUMMARISER_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(SUMMARISER_TIMEOUT_MS),
  });
  // `result.text` resolves once the stream finishes — the AI SDK
  // accumulates deltas internally so we get the full final string
  // even though we used streamText.
  const text = await result.text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return formatCompactSummary(trimmed);
};

/**
 * Produce a compact natural-language summary of the given messages.
 * Returns `null` on any non-recoverable failure so callers can soft-
 * fail (i.e. keep the uncompacted history for this turn rather than
 * risk degrading the model with a half-baked summary).
 *
 * On a context-length error from the summariser provider, drop the
 * oldest 20% of API rounds and retry, up to `MAX_PTL_RETRIES` times.
 */
export const summariseMessages = async (
  messages: UIMessage[],
): Promise<string | null> => {
  if (messages.length === 0) return null;

  let current = messages;
  let attempt = 0;
  while (attempt <= MAX_PTL_RETRIES) {
    try {
      return await runSummariser(current);
    } catch (err) {
      if (looksLikeContextOverflow(err) && attempt < MAX_PTL_RETRIES) {
        const { messages: smaller, droppedRounds } = dropOldestRounds(
          current,
          PTL_DROP_FRACTION,
        );
        if (droppedRounds === 0) {
          // Nothing left to drop — fall through to the soft-fail
          // branch below.
          console.warn(
            `[compaction:summariser] context-overflow but cannot drop further: attempt=${attempt.toString()} messageCount=${current.length.toString()}`,
          );
          return null;
        }
        console.warn(
          `[compaction:summariser] context-overflow retry: attempt=${attempt.toString()} droppedRounds=${droppedRounds.toString()} remainingMessages=${smaller.length.toString()}`,
        );
        current = smaller;
        attempt++;
        continue;
      }
      console.warn(
        `[compaction:summariser] failed, keeping uncompacted history: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  console.warn(
    `[compaction:summariser] exhausted PTL retries (${MAX_PTL_RETRIES.toString()}), keeping uncompacted history`,
  );
  return null;
};
