import { getLiveStateSync } from "@fretik/shared/services/model-registry/live";
import type { UIMessage } from "ai";
import { parseIntEnv } from "../../agents/shared/env";
import type { ModelProfile } from "../../lib/model-registry/types";
import { withNamedTrace } from "../../lib/trace-tool";
import { microcompactMessages } from "./microcompact";
import { getCompactUserSummaryMessage } from "./prompt";
import {
  buildSyntheticActivationReplayMessage,
  extractRuntimeState,
  formatRuntimeStateForSummary,
} from "./runtime-state-attachments";
import {
  parseSummariserMaxTokens,
  serialiseMessageBlocks,
  summariseMessages,
} from "./summarizer";
import { estimateMessagesTokens } from "./token-estimator";
import { mechanicalSummary } from "./turn-boundary";

/**
 * Conversation compaction — full alignment with Claude Code's pattern
 * (`claude-code/src/services/compact/`).
 *
 * Pipeline (mirrors CC):
 *   1. **Microcompact** (always): walk the message tree and replace
 *      old, stateless tool-results (RAG / SQL / read / etc.) with a
 *      compact marker. Cheap, may already pull the conversation
 *      below threshold and skip the heavyweight summariser.
 *      See `./microcompact.ts`.
 *   2. **Threshold check**: if total estimated tokens are still above
 *      the compaction threshold, fire the summariser; otherwise
 *      return the (microcompacted) array as-is.
 *   3. **Summarisation**: `summariseMessages` runs the 9-section CC
 *      prompt over ALL prior messages, with PTL retry baked in (it
 *      drops oldest 20% of API rounds and retries on context-overflow,
 *      max 3 attempts). Returns `null` on any non-recoverable failure.
 *   4. **Runtime-state attachments**: extract `activatedTools` (from
 *      past `searchTools` results). Inject it into the summary text
 *      AND synthesize a fake
 *      `tool-searchTools` message so `replayActivationFromHistory`
 *      finds the cumulative activation set after compaction —
 *      without any code changes in `dynamic-tools.ts`.
 *   5. **Replacement**: return `[summaryUserMessage,
 *      syntheticReplayAssistantMessage?, ...verbatimTail]` — the
 *      summary covers everything up to the tail, and the last few
 *      messages are carried through untouched. See
 *      `KEEP_TAIL_TOKENS` for why the tail exists and what bounds it.
 *
 * Soft-fail policy: when the summariser fails (timeout, rate limit,
 * unrecoverable PTL, malformed output) we return the microcompacted
 * array uncompacted. The microcompact pass alone often saves enough
 * tokens to keep the next provider call within budget. If even that
 * is insufficient, the provider error surfaces naturally as an
 * SSE error — no special 422 envelope. This is intentional: the
 * previous `CompactionFailureError` + 422 path was a hard-cap response
 * we no longer need now that the threshold reserves output space and
 * PTL retries handle the summariser's own context overflow.
 *
 * Sources of truth that drive the threshold computation:
 *   - the serving model's context window — `profile.catalog.contextLength`
 *     from the model registry, passed by the caller (no more
 *     `OPENROUTER_CHAT_MODEL_CONTEXT` env: the threshold follows the
 *     model that actually serves the conversation)
 *   - `SUMMARISER_MAX_TOKENS` (default 20_000, env-overridable via
 *     `COMPACTION_SUMMARIZER_MAX_TOKENS` — see summarizer.ts) reserves
 *     room for the summary output itself.
 *   - `AUTOCOMPACT_BUFFER_TOKENS` (13_000, CC value — headroom for
 *     the next response on top of the summary)
 *
 * @see ./summarizer.ts
 * @see ./microcompact.ts
 * @see ./runtime-state-attachments.ts
 * @see claude-code/src/services/compact/compact.ts
 * @see claude-code/src/services/compact/autoCompact.ts (effective-window
 *      computation that we mirror here)
 */

/**
 * Headroom buffer between the threshold and the effective context
 * window — leaves ~13K tokens for the model's next response on top
 * of the reserved summary output. Mirrors CC
 * `autoCompact.ts::AUTOCOMPACT_BUFFER_TOKENS`. Not env-overridable on
 * purpose: this is a CC-validated constant tied to the rest of the
 * effective-window arithmetic, not a tuning knob.
 */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * Tokens reserved for the summary output itself — same clamp logic the
 * summariser applies, captured once at module load.
 */
const SUMMARISER_MAX_TOKENS = parseSummariserMaxTokens(
  process.env.COMPACTION_SUMMARIZER_MAX_TOKENS,
);

/**
 * Token threshold above which compaction fires, derived from the
 * SERVING model's profile: effective window (context − reserved
 * summary output) minus the autocompact buffer. For MiniMax M2.7
 * (204.8K) with the default 20K reserve this lands at 171.8K — close
 * to CC's 83.5% on Sonnet but derived rather than tuned, so it stays
 * correct for any model swap or per-conversation override (C8): the
 * threshold always follows the profile passed by the caller.
 *
 * `maxThresholdTokens` caps that derivation at an ABSOLUTE number.
 * The derived figure answers "will the next call fit"; on a 1M-context
 * model it answers yes until ~960K, which is far past the point where
 * accuracy has already gone (see `agents/shared/context-ceiling.ts` for
 * the measured fall). Callers that care about staying accurate — not
 * merely about fitting — pass the ceiling here. Nothing changes for a
 * caller that does not: `min` can only lower the threshold.
 */
export const getCompactionThresholdTokens = (
  profile: ModelProfile,
  maxThresholdTokens?: number,
): number => {
  const derived =
    effectiveContextLength(profile) -
    SUMMARISER_MAX_TOKENS -
    AUTOCOMPACT_BUFFER_TOKENS;
  return maxThresholdTokens === undefined
    ? derived
    : Math.min(derived, maxThresholdTokens);
};

/**
 * The context window a request can actually use, which is NOT the catalogue
 * headline.
 *
 * A model is served by several hosts and routing picks one per request, so the
 * usable window is the SMALLEST any reachable host offers. Measured 2026-08-29:
 * the same model spans 262 144 to 1 048 576 tokens across its endpoints, and
 * budgeting against the largest silently overflows whenever the request lands on
 * the smallest — which is a mid-turn failure, not a degradation. The nightly
 * sync computes the pool minimum (less a safety margin) and writes it here.
 *
 * The catalogue figure remains the answer while the snapshot is cold or the
 * model has no row: it is what this code used before the pool was measured, and
 * an unreachable metadata table must not change how a turn is budgeted.
 */
const effectiveContextLength = (profile: ModelProfile): number =>
  getLiveStateSync(profile.key)?.effectiveContextLength ??
  profile.catalog.contextLength;

export interface CompactionSummaryMetadata {
  type: "compaction_summary";
  compactedMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  createdAt: string;
}

/**
 * Progress events emitted (when caller passes `onProgress`) ONLY when
 * the heavyweight summarisation path actually fires — i.e. tokens
 * crossed the compaction threshold. Below-threshold runs (fast,
 * microcompact-only) never fire a progress event so the UI doesn't
 * flash a "Compacting…" indicator for short conversations.
 *
 * Events:
 *   - `started`   summariser invocation about to begin; `tokensBefore`
 *                 captures the post-microcompact size.
 *   - `succeeded` summary stream completed; `tokensAfter` reflects the
 *                 final replacement-message size, `reductionPct` is
 *                 the saved fraction (0–100).
 *   - `failed`    summariser returned null (timeout, PTL exhausted,
 *                 malformed output). The handler still gets back a
 *                 valid (uncompacted) message array, but the UI can
 *                 surface "compaction unavailable" so the user knows
 *                 why context might feel cramped.
 */
export type CompactionProgressEvent =
  | { phase: "started"; tokensBefore: number }
  | {
      phase: "succeeded";
      tokensBefore: number;
      tokensAfter: number;
      reductionPct: number;
    }
  | { phase: "failed"; tokensBefore: number };

export type CompactionProgressCallback = (
  event: CompactionProgressEvent,
) => void;

export interface CompactConversationOptions {
  /**
   * Profile of the model that will serve the next turn — drives the
   * compaction threshold via `getCompactionThresholdTokens`.
   */
  profile: ModelProfile;
  /**
   * Team whose workhorse pick (C8b) the summariser model honours. Undefined
   * falls back to the code default.
   */
  teamId?: string;
  /**
   * Optional progress hook. Fires only on the heavyweight path
   * (above the compaction threshold). Errors thrown by the
   * callback are caught and logged so a buggy listener never aborts
   * compaction itself.
   */
  onProgress?: CompactionProgressCallback;
  /**
   * Absolute cap on the threshold — see `getCompactionThresholdTokens`.
   * Omitted keeps the window-derived value.
   */
  maxThresholdTokens?: number;
  /**
   * Fired once, on the success path only, with everything needed to PERSIST
   * the compaction as a checkpoint.
   *
   * A callback rather than a richer return type because the two consumers are
   * unrelated: the turn needs the messages now, the checkpoint writer needs
   * the artefact later and must not make the turn wait for it. Callers that
   * pass nothing keep the previous, purely in-memory behaviour — which is
   * still the right one for a path with no conversation to attach to.
   */
  onCompacted?: (artifact: CompactionArtifact) => void;
  /**
   * Conversation to file the Langfuse `compaction` observation under.
   *
   * Needed because compaction is no longer always inside a turn. Moving the
   * summariser to `compactAheadOfNextTurn` moved it out of `chatbot-turn`'s
   * span, and `telemetryFor("compaction")` does NOT name anything on its own —
   * AI SDK v7 hardcodes the span name to `chat <model>` and files the
   * functionId under `gen_ai.agent.name`. The package convention lists
   * `compaction` among the stable trace names; without an opened observation
   * the async path lands in the same anonymous bucket as every agent turn, and
   * "what does compaction cost" stops being answerable by a query. Verified
   * 2026-09-18: zero observations named `compaction` in 30 days.
   *
   * Omitted leaves tracing alone, which is right for the callers that have no
   * conversation to attach to.
   */
  traceSessionId?: string;
}

/** What a compaction produced, in the form a checkpoint stores it. */
export interface CompactionArtifact {
  /**
   * The ASSEMBLED handoff message, not the raw summariser output — storing
   * the assembled text is what lets a resumed window reproduce byte-for-byte
   * what the turn that wrote it used, instead of re-deriving it under
   * whatever the prompt code says at read time.
   */
  summary: string;
  activatedTools: string[];
  tokensBefore: number;
  tokensAfter: number;
  /**
   * How many trailing messages of the input the summary does NOT cover, because
   * they were kept verbatim.
   *
   * The checkpoint's cut has to move back by exactly this many, or the tail is
   * summarised AND left in the window on the next turn — or worse, summarised
   * and then excluded from it. The caller translates this count into a row,
   * which it can do because compaction preserves the array's length and order.
   */
  keptTailCount: number;
}

/**
 * How much of the most recent conversation survives a compaction verbatim.
 *
 * A summary is lossy by construction, and the loss is not spread evenly over
 * what it folds: the oldest exchanges are the ones a summary represents well —
 * the outcome is what mattered about them — while the newest are the ones the
 * next turn is most likely to be ABOUT, where the exact wording, the number,
 * the file path and the user's phrasing are the content. Folding those into
 * prose is where a compacted conversation starts answering questions about
 * itself from memory. Anthropic's context editing keeps a tail of tool uses for
 * the same reason, and Gemini CLI keeps 30 % of the history.
 *
 * 12 000 tokens is a BOUND, not a measurement — roughly the last couple of
 * exchanges on ordinary traffic. Nothing in either eval family measures what it
 * buys: both probe recall of OLD history, which is precisely the half a summary
 * is good at, so they would score a tail at zero. The case that would measure it
 * ("what did you just tell me") does not exist yet, which is why this is a
 * tunable with a conservative default rather than a derived figure.
 *
 * Bounded a second time, as a fraction of the threshold, and that is the bound
 * that makes it safe: a tail free to grow with the history would carry the
 * conversation straight back over the threshold, compacting on every turn
 * forever. At a quarter of the threshold, a compaction always lands the next
 * turn at a quarter of the cap or less, whatever the tail budget says.
 */
const KEEP_TAIL_TOKENS = parseIntEnv("COMPACTION_KEEP_TAIL_TOKENS", {
  fallback: 12_000,
  min: 0,
  max: 200_000,
});
const KEEP_TAIL_MAX_THRESHOLD_FRACTION = 0.25;

/**
 * Split a history into the part a summary replaces and the part it precedes.
 *
 * Walks backwards while the tail fits its budget and stops at the first message
 * that would not. No alignment on turn boundaries, deliberately: a tool call and
 * its result live in the SAME `UIMessage`, so there is no pair a split between
 * messages can break, and the only other candidate rule — "start the tail at a
 * user message" — would throw away the single most recent answer whenever that
 * answer is the only thing that fits, which is the exact case the tail exists
 * for.
 *
 * The head always keeps at least one message — a summariser with nothing to
 * read produces nothing to hand over. It is a floor, not a live branch: the
 * caller is here only because the history is OVER the threshold, and the budget
 * is at most a quarter of it, so a tail can never reach the first message.
 */
const splitVerbatimTail = (
  messages: UIMessage[],
  profile: ModelProfile,
  budget: number,
): { head: UIMessage[]; tail: UIMessage[] } => {
  if (budget <= 0 || messages.length < 2) return { head: messages, tail: [] };
  let used = 0;
  let start = messages.length;
  while (start > 1) {
    const candidate = messages[start - 1];
    if (candidate === undefined) break;
    // Per message, so the estimator's per-message memo is what answers here —
    // this walk costs nothing a turn has not already paid.
    const cost = estimateMessagesTokens([candidate], profile);
    if (used + cost > budget) break;
    used += cost;
    start -= 1;
  }
  return { head: messages.slice(0, start), tail: messages.slice(start) };
};

/**
 * Verbatim tail the mechanical rung may copy when the summariser does not
 * answer. Sized against the cap it has to fit under, not against the transcript
 * it folds: at roughly two characters per token on tool output, 24 000
 * characters is about 12 000 tokens — a fifth of a 65 000-token cap, so the
 * result reduces even when the transcript barely exceeded it.
 */
const MECHANICAL_VERBATIM_BUDGET_CHARS = 24_000;

const safeProgress = (
  cb: CompactionProgressCallback | undefined,
  event: CompactionProgressEvent,
): void => {
  if (!cb) return;
  try {
    cb(event);
  } catch (err) {
    console.warn(
      `[compaction] onProgress callback threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

/**
 * Returns a compacted message list suitable to pass to the model for
 * the next turn. When no compaction is triggered the input array is
 * returned unchanged by reference (or via microcompact when stale
 * tool-results are cleared).
 */
export const compactConversation = async (
  messages: UIMessage[],
  options: CompactConversationOptions,
): Promise<UIMessage[]> => {
  const { onProgress, profile, teamId, maxThresholdTokens, onCompacted } =
    options;
  const threshold = getCompactionThresholdTokens(profile, maxThresholdTokens);

  // Step 1 — microcompact (always cheap, often skips the summariser).
  const microcompacted = microcompactMessages(messages);

  // Step 2 — threshold check. Below threshold: silent fast path; we
  // intentionally do NOT fire `onProgress` so the UI never flashes a
  // "Compacting…" indicator for short conversations.
  const totalTokens = estimateMessagesTokens(microcompacted, profile);
  if (totalTokens <= threshold) {
    console.info(
      `[compaction] skipped reason=below_threshold tokens=${totalTokens.toString()} threshold=${threshold.toString()}`,
    );
    return microcompacted;
  }

  // Step 3 — full summarisation.
  //
  // The observation opens HERE and not around the whole function, because
  // above this line is the fast path that most turns take: naming the trace
  // earlier would file one empty `compaction` root per turn and bury the
  // handful that did real work under thousands that did none.
  const { head, tail } = splitVerbatimTail(
    microcompacted,
    profile,
    Math.min(
      KEEP_TAIL_TOKENS,
      Math.floor(threshold * KEEP_TAIL_MAX_THRESHOLD_FRACTION),
    ),
  );
  console.info(
    `[compaction] starting tokens=${totalTokens.toString()} threshold=${threshold.toString()} messageCount=${microcompacted.length.toString()} keptTail=${tail.length.toString()}`,
  );
  safeProgress(onProgress, { phase: "started", tokensBefore: totalTokens });
  const llmSummary = await (options.traceSessionId === undefined
    ? summariseMessages(head, teamId)
    : withNamedTrace(
        "compaction",
        {
          sessionId: options.traceSessionId,
          metadata: {
            tokensBefore: totalTokens.toString(),
            threshold: threshold.toString(),
          },
        },
        () => summariseMessages(head, teamId),
      ));

  // Rung two, for when the summariser does not answer.
  //
  // Returning the history untouched here was a silent guarantee of a wasted
  // turn: the caller has already decided the history is over the cap, so the
  // request built from it is over the ceiling too, and the turn dies at step
  // zero having done nothing. Measured 2026-09-18 on a workflow run — the
  // summariser timed out at its 90-second budget on 2 of 10 attempts, and each
  // failure cost exactly one such turn.
  //
  // The turn boundary already owns a ladder for the identical problem, and the
  // two sides agree on the same `string[]` block shape (`serialiseMessageBlocks`
  // for `UIMessage`, `serialiseModelMessageBlocks` for `ModelMessage`), so the
  // rung is reused rather than rewritten. It is a weaker handover than five
  // written sections; it is a handover, which is the whole difference from
  // no compaction at all.
  const summary =
    llmSummary ??
    mechanicalSummary(
      serialiseMessageBlocks(head),
      MECHANICAL_VERBATIM_BUDGET_CHARS,
    );
  if (llmSummary === null) {
    console.warn(
      `[compaction] summariser_failed tokens=${totalTokens.toString()} falling_back=mechanical`,
    );
  }

  // Step 4 — runtime-state extraction (active tools + pending tasks).
  const runtimeState = extractRuntimeState(microcompacted);
  const runtimeStateText = formatRuntimeStateForSummary(runtimeState);

  // Step 5 — assemble the replacement message(s).
  const summaryText = getCompactUserSummaryMessage(summary, runtimeStateText);
  const summaryMessage: UIMessage = {
    id: `compaction-summary-${crypto.randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: summaryText }],
    metadata: {
      type: "compaction_summary",
      compactedMessageCount: head.length,
      estimatedTokensBefore: totalTokens,
      estimatedTokensAfter: 0, // updated below
      createdAt: new Date().toISOString(),
    } satisfies CompactionSummaryMetadata,
  };

  const replayMessage = buildSyntheticActivationReplayMessage(
    runtimeState.activatedTools,
  );

  const compacted: UIMessage[] = replayMessage
    ? [summaryMessage, replayMessage, ...tail]
    : [summaryMessage, ...tail];

  const tokensAfter = estimateMessagesTokens(compacted, profile);

  // The same invariant the turn-boundary ladder enforces: a compaction that
  // does not reduce is not a compaction. It cannot bite on the LLM rung, whose
  // output is bounded by `SUMMARISER_MAX_TOKENS`; it is here for the mechanical
  // one, which reproduces every distinct error verbatim and can therefore
  // outgrow a transcript made of few enormous messages. Returning the
  // microcompacted history then is no improvement — but it is honest, and it is
  // strictly better than swapping a history for something larger.
  if (tokensAfter >= totalTokens) {
    console.warn(
      `[compaction] rejected reason=no_reduction tokensBefore=${totalTokens.toString()} tokensAfter=${tokensAfter.toString()} kind=${llmSummary === null ? "mechanical" : "llm"}`,
    );
    safeProgress(onProgress, { phase: "failed", tokensBefore: totalTokens });
    return microcompacted;
  }

  // Patch the metadata in place — the message is still ours, no
  // sharing concerns. Doing it post-hoc avoids a double-estimation.
  const md = summaryMessage.metadata as CompactionSummaryMetadata;
  md.estimatedTokensAfter = tokensAfter;

  const reductionPct =
    totalTokens > 0 ? Math.round((1 - tokensAfter / totalTokens) * 100) : 0;
  console.info(
    `[compaction] succeeded tokensBefore=${totalTokens.toString()} tokensAfter=${tokensAfter.toString()} reduction=${reductionPct.toString()}% summarisedMessages=${head.length.toString()} keptTail=${tail.length.toString()} activatedToolsPreserved=${runtimeState.activatedTools.length.toString()}`,
  );
  safeProgress(onProgress, {
    phase: "succeeded",
    tokensBefore: totalTokens,
    tokensAfter,
    reductionPct,
  });
  if (onCompacted) {
    try {
      onCompacted({
        summary: summaryText,
        activatedTools: runtimeState.activatedTools,
        tokensBefore: totalTokens,
        tokensAfter,
        keptTailCount: tail.length,
      });
    } catch (err) {
      // Same policy as `onProgress`: a listener is an observer, and an
      // observer that throws must not cost the turn its compacted history.
      console.warn(
        `[compaction] onCompacted callback threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return compacted;
};
