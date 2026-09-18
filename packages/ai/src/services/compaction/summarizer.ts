import { type UIMessage, streamText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { resolveModelForTeam } from "../../lib/model-registry/team-model";
import { dropOldestRounds } from "./grouping";
import {
  buildSummariserPrompt,
  formatCompactSummary,
  getCompactPrompt,
  looksLikeSummary,
} from "./prompt";

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
 * Compaction summariser model — the registry's `compaction-summarizer`
 * role (default `deepseek/deepseek-v4-flash-0731`: 1M-token context keeps
 * very long older blocks within reach at a price well below the
 * previous `gpt-oss-120b`, which capped us at 131K). It is a workhorse-tier
 * role, so a team's workhorse pick (C8b) overrides the default — resolved per
 * call in `runSummariser` via `resolveModelForTeam`. Changing the code default
 * is a reviewed edit to `model-registry/profiles.ts`, not an env flip — A/B
 * runs go through the eval harness.
 */

/**
 * Upper bound on the summary length, aligned with Claude Code's
 * `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` (p99.99 observation was
 * 17.4K tokens). Bumped from the previous 8K because the 9-section
 * prompt produces longer summaries than the old 5-section prompt did.
 *
 * Env override: `COMPACTION_SUMMARIZER_MAX_TOKENS`, clamped
 * `[2_000, 32_000]`.
 */
export const parseSummariserMaxTokens = (raw: string | undefined): number => {
  if (!raw) return 20_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20_000;
  return Math.min(32_000, Math.max(2_000, Math.floor(parsed)));
};

export const SUMMARISER_MAX_TOKENS = parseSummariserMaxTokens(
  process.env.COMPACTION_SUMMARIZER_MAX_TOKENS,
);

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
export const parseSummariserTimeoutMs = (raw: string | undefined): number => {
  if (!raw) return 90_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 90_000;
  return Math.min(300_000, Math.max(10_000, Math.floor(parsed)));
};

const SUMMARISER_TIMEOUT_MS = parseSummariserTimeoutMs(
  process.env.COMPACTION_SUMMARIZER_TIMEOUT_MS,
);

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

const PART_TOOL_PREFIX = "tool-";

/**
 * Flatten a `UIMessage` into plain text suitable for an LLM prompt.
 * - `text` parts → kept verbatim.
 * - `tool-<name>` parts in `output-available` state → flatten name +
 *   stringified output (so the summariser sees what the tool
 *   returned). Stringification is best-effort; circular refs would
 *   throw, in which case we fall back to a plain `[tool:<name>]`
 *   marker. The output is bounded by the per-message persisted-output
 *   fence, so the serialised text stays within the summariser's input
 *   budget.
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

/**
 * Role-prefixed blocks, one per message that carries anything. The transcript
 * the summariser reads is these joined by a blank line — kept as an array so
 * the boundary path (`summariseTranscript`) can drop the oldest ones on a
 * prompt-too-long retry without re-deriving them.
 */
export const serialiseMessageBlocks = (messages: UIMessage[]): string[] =>
  messages
    .map((m) => {
      const body = extractMessageText(m);
      return body.length > 0 ? `[${m.role}] ${body}` : "";
    })
    .filter((line) => line.length > 0);

/**
 * How long a call may go without producing CONTENT before we treat its route
 * as dead.
 *
 * Measured 2026-09-18: every summariser failure in the production sample sat
 * at exactly the 90-second total budget with `input_tokens=0`,
 * `output_tokens=0` and no serving provider recorded, while healthy calls on
 * the same model ran 16 s to 71 s and streamed throughout. A dead route and a
 * slow one are trivially separable, and only the dead one is worth retrying —
 * OpenRouter picks a different upstream on a fresh request, and the sample
 * alone shows makora, baseten and fireworks serving this model.
 *
 * Retrying inside the SAME total budget is what makes this free: the ladder
 * still spends at most `SUMMARISER_TIMEOUT_MS` end to end, so nothing gets
 * slower; a stall that used to consume the whole budget now consumes half.
 *
 * The timer RE-ARMS on every delta rather than firing once on the first one,
 * and that is not a refinement — the first version cleared it on any chunk at
 * all and was defeated on its first field test. A 340 000-token run
 * (00:04:55Z) opened a stream, emitted something that was not content, then
 * produced nothing for the remaining 90 seconds: one generation, 89.991 s, no
 * usage, and no retry, because the timer had already been cancelled. Re-arming
 * on content covers "never started" and "started then died" with one
 * mechanism, and a stream that is genuinely slow never trips it.
 *
 * Env override: `COMPACTION_SUMMARIZER_STALL_MS`, clamped `[5_000, 120_000]`.
 */
export const parseSummariserStallMs = (raw: string | undefined): number => {
  if (!raw) return 45_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 45_000;
  return Math.min(120_000, Math.max(5_000, Math.floor(parsed)));
};

const SUMMARISER_STALL_MS = parseSummariserStallMs(
  process.env.COMPACTION_SUMMARIZER_STALL_MS,
);

/**
 * Retries for a failure that is neither a refusal nor an overflow: a stalled
 * route, a transport error, or a model that answered with something that is
 * not a summary. One, because the budget is shared — a second retry could
 * only run with no time left.
 */
const MAX_TRANSIENT_RETRIES = 1;

/**
 * A transcript that knows how to make itself smaller.
 *
 * The two summariser entry points differ in exactly one way — what "the
 * oldest fifth" means. `summariseMessages` owns whole API rounds and must not
 * cut one in half; `summariseTranscript` has only blocks, because a serialised
 * transcript no longer knows where a round began. Everything else — the
 * prompt assembly, the timeout, the envelope check, the retry policy — was
 * duplicated between them, and the duplication is how the two sides drifted.
 */
interface Shrinkable {
  readonly blocks: string[];
  /** The same transcript minus its oldest rounds, or `null` when at the end. */
  readonly shrink: () => Shrinkable | null;
}

const fromMessages = (messages: UIMessage[]): Shrinkable => ({
  blocks: serialiseMessageBlocks(messages),
  shrink: () => {
    const { messages: smaller, droppedRounds } = dropOldestRounds(
      messages,
      PTL_DROP_FRACTION,
    );
    return droppedRounds === 0 ? null : fromMessages(smaller);
  },
});

const fromBlocks = (blocks: readonly string[]): Shrinkable => ({
  blocks: [...blocks],
  shrink: () => {
    const dropped = Math.ceil(blocks.length * PTL_DROP_FRACTION);
    const rest = blocks.slice(dropped);
    return rest.length === 0 ? null : fromBlocks(rest);
  },
});

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
 * One summariser invocation, under a wall-clock budget it must not exceed.
 *
 * Returns the formatted summary, or `null` when the model answered with
 * something that is not one. Throws only on transport / provider errors, so
 * the loop above can tell an overflow from a stall.
 *
 * The `null` branch is the one that matters. It used to not exist: any
 * non-empty string was installed over the conversation, and the production
 * sample shows what that admits — `RCN-8842-QK`, eleven characters, standing
 * in for 578 220 tokens of history. `looksLikeSummary` is the whole of the
 * fix, and `prompt.ts` is where the measurement behind it is written down.
 */
const runSummariser = async (params: {
  prompt: string;
  teamId: string | undefined;
  budgetMs: number;
}): Promise<string | null> => {
  const compactionModel = (
    await resolveModelForTeam("compaction-summarizer", params.teamId)
  ).model;
  const stalled = new AbortController();
  const stallMs = Math.min(SUMMARISER_STALL_MS, params.budgetMs);
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled.abort(
        new Error(
          `summariser produced no content for ${stallMs.toString()}ms — route treated as dead`,
        ),
      );
    }, stallMs);
  };
  armStall();
  try {
    const result = streamText({
      model: compactionModel,
      prompt: params.prompt,
      temperature: SUMMARISER_TEMPERATURE,
      maxOutputTokens: SUMMARISER_MAX_TOKENS,
      abortSignal: AbortSignal.any([
        stalled.signal,
        AbortSignal.timeout(params.budgetMs),
      ]),
      // DELTAS only. A stream also carries starts, finishes and provider
      // frames, and a route that emits one of those and then dies is exactly
      // the failure this timer exists to catch — accepting any chunk as
      // progress is how the first version of it was defeated. Reasoning
      // deltas count: the bound model thinks before it writes, and a route
      // that is thinking is alive.
      onChunk: ({ chunk }) => {
        if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
          armStall();
        }
      },
      // Nests this summariser generation under the turn's `chatbot-turn`
      // span (it runs inside `execute`'s active observation). No-op when
      // Langfuse is unconfigured.
      telemetry: telemetryFor("compaction"),
    });
    // `result.text` resolves once the stream finishes — the AI SDK
    // accumulates deltas internally so we get the full final string
    // even though we used streamText.
    const trimmed = (await result.text).trim();
    if (trimmed.length === 0) return null;
    if (!looksLikeSummary(trimmed)) {
      // Length and finish reason only: the text itself is conversation
      // content and has no business in a log line.
      console.warn(
        `[compaction:summariser] discarded a response that is not a summary: chars=${trimmed.length.toString()} finish=${await result.finishReason}`,
      );
      return null;
    }
    return formatCompactSummary(trimmed);
  } finally {
    clearTimeout(stallTimer);
  }
};

/**
 * The summariser, with its whole retry policy in one place.
 *
 * Three failures, three answers:
 *  - **the prompt is too long** — drop the oldest fifth and go again, up to
 *    `MAX_PTL_RETRIES` times (Claude Code's pattern);
 *  - **the route stalled, or the model did not write a summary** — go again
 *    once, which re-routes;
 *  - **anything else** — give up and return `null`.
 *
 * Every attempt shares ONE deadline. That is what keeps a retry free: the
 * ladder still spends at most `SUMMARISER_TIMEOUT_MS`, so adding a second
 * chance costs no latency, it only uses the budget a stalled route was
 * wasting. When the budget is gone there is no attempt left to make, which is
 * also why the loop needs no separate bound.
 */
const summarise = async (params: {
  source: Shrinkable;
  instruction: string;
  teamId: string | undefined;
  label: string;
}): Promise<string | null> => {
  const deadline = Date.now() + SUMMARISER_TIMEOUT_MS;
  let source = params.source;
  let overflowRetries = 0;
  let transientRetries = 0;

  const retryTransiently = (why: string): boolean => {
    const remaining = deadline - Date.now();
    if (transientRetries >= MAX_TRANSIENT_RETRIES || remaining < 5_000) {
      console.warn(
        `[compaction:summariser] ${params.label} giving up: ${why} (retries=${transientRetries.toString()} remainingMs=${remaining.toString()})`,
      );
      return false;
    }
    transientRetries += 1;
    console.warn(
      `[compaction:summariser] ${params.label} retrying: ${why} (remainingMs=${remaining.toString()})`,
    );
    return true;
  };

  for (;;) {
    let outcome: string | null;
    try {
      outcome = await runSummariser({
        prompt: buildSummariserPrompt(params.instruction, source.blocks),
        teamId: params.teamId,
        budgetMs: Math.max(1_000, deadline - Date.now()),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (looksLikeContextOverflow(err) && overflowRetries < MAX_PTL_RETRIES) {
        const smaller = source.shrink();
        if (!smaller) {
          console.warn(
            `[compaction:summariser] ${params.label} context-overflow but cannot drop further: blocks=${source.blocks.length.toString()}`,
          );
          return null;
        }
        overflowRetries += 1;
        console.warn(
          `[compaction:summariser] ${params.label} context-overflow retry ${overflowRetries.toString()}: blocks ${source.blocks.length.toString()} → ${smaller.blocks.length.toString()}`,
        );
        source = smaller;
        continue;
      }
      if (retryTransiently(message)) continue;
      return null;
    }
    if (outcome !== null) return outcome;
    if (retryTransiently("response was not a summary")) continue;
    return null;
  }
};

/**
 * Produce a compact natural-language summary of the given messages.
 * Returns `null` on any non-recoverable failure so callers can fall back —
 * `compact.ts` then derives a mechanical summary rather than keeping a history
 * it has already judged too large.
 */
export const summariseMessages = async (
  messages: UIMessage[],
  teamId: string | undefined,
): Promise<string | null> => {
  if (messages.length === 0) return null;
  return summarise({
    source: fromMessages(messages),
    instruction: getCompactPrompt(),
    teamId,
    label: "conversation",
  });
};

/**
 * Same summariser, over an already-serialised transcript and under a caller's
 * own instruction.
 *
 * The turn-boundary path (`./turn-boundary.ts`) summarises a PARTIAL turn,
 * which lives as `ModelMessage[]` and not as the `UIMessage[]` a conversation
 * is persisted in — and it asks a different question of the model (what was
 * tried and failed, not what the user wants). Both differences are inputs, so
 * they share everything else through `summarise` above.
 *
 * Returns `null` on any non-recoverable failure — callers keep whatever they
 * had, exactly as `summariseMessages` callers do.
 */
export const summariseTranscript = async (params: {
  blocks: string[];
  instruction: string;
  teamId: string | undefined;
}): Promise<string | null> => {
  if (params.blocks.length === 0) return null;
  return summarise({
    source: fromBlocks(params.blocks),
    instruction: params.instruction,
    teamId: params.teamId,
    label: "boundary",
  });
};
