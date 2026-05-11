import type { UIMessage } from "ai";
import { microcompactMessages } from "./microcompact";
import { getCompactUserSummaryMessage } from "./prompt";
import {
  buildSyntheticActivationReplayMessage,
  extractRuntimeState,
  formatRuntimeStateForSummary,
} from "./runtime-state-attachments";
import { summariseMessages } from "./summarizer";
import { estimateMessagesTokens } from "./token-estimator";

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
 *      `COMPACTION_THRESHOLD_TOKENS`, fire the summariser; otherwise
 *      return the (microcompacted) array as-is.
 *   3. **Summarisation**: `summariseMessages` runs the 9-section CC
 *      prompt over ALL prior messages, with PTL retry baked in (it
 *      drops oldest 20% of API rounds and retries on context-overflow,
 *      max 3 attempts). Returns `null` on any non-recoverable failure.
 *   4. **Runtime-state attachments**: extract `activatedTools` (from
 *      past `searchTools` results) and pending `manageTasks` snapshot.
 *      Inject them into the summary text AND synthesize a fake
 *      `tool-searchTools` message so `replayActivationFromHistory`
 *      finds the cumulative activation set after compaction —
 *      without any code changes in `dynamic-tools.ts`.
 *   5. **Replacement**: return `[summaryUserMessage,
 *      syntheticReplayAssistantMessage?]`. There is NO "kept verbatim
 *      tail" — that was a Fretik divergence from CC that this rewrite
 *      removes (Sprint A §3.3 hard-cap → CC effective-window pattern).
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
 *   - `OPENROUTER_CHAT_MODEL_CONTEXT` (default 196_608, MiniMax M2.7)
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

const PRIMARY_MODEL_CONTEXT_TOKENS = (() => {
  const raw = process.env.OPENROUTER_CHAT_MODEL_CONTEXT;
  if (!raw) return 196_608;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 196_608;
  return Math.floor(parsed);
})();

/**
 * Tokens reserved for the summary output itself. Read directly from
 * the same env (`COMPACTION_SUMMARIZER_MAX_TOKENS`) the summariser
 * reads — duplicating the clamp here rather than importing from
 * `./summarizer` is a deliberate decoupling: each module captures
 * the env at load time, and re-importing only `compact.ts` (the
 * test pattern) would otherwise reuse the cached `summarizer.ts`
 * module's frozen value, hiding env-driven threshold shifts behind
 * stale state.
 */
const SUMMARISER_MAX_TOKENS = (() => {
  const raw = process.env.COMPACTION_SUMMARIZER_MAX_TOKENS;
  if (!raw) return 20_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20_000;
  return Math.min(32_000, Math.max(2_000, Math.floor(parsed)));
})();

/**
 * Effective window = full context − reserved summary output. The
 * threshold and any next-turn budget are computed from this, not the
 * raw model window, so we never plan a turn whose summary alone
 * couldn't fit.
 */
const EFFECTIVE_CONTEXT_TOKENS =
  PRIMARY_MODEL_CONTEXT_TOKENS - SUMMARISER_MAX_TOKENS;

/**
 * Token threshold above which compaction fires. Below it we return
 * the (microcompacted) array unchanged. For MiniMax M2.7 (196K) with
 * the default 20K summary reserve this lands at 163K — close to CC's
 * 83.5% on Sonnet but derived rather than tuned, so it stays correct
 * for any model swap via `OPENROUTER_CHAT_MODEL_CONTEXT`.
 */
export const COMPACTION_THRESHOLD_TOKENS =
  EFFECTIVE_CONTEXT_TOKENS - AUTOCOMPACT_BUFFER_TOKENS;

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
 * crossed `COMPACTION_THRESHOLD_TOKENS`. Below-threshold runs (fast,
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
   * Optional progress hook. Fires only on the heavyweight path
   * (above `COMPACTION_THRESHOLD_TOKENS`). Errors thrown by the
   * callback are caught and logged so a buggy listener never aborts
   * compaction itself.
   */
  onProgress?: CompactionProgressCallback;
}

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
  options: CompactConversationOptions = {},
): Promise<UIMessage[]> => {
  const { onProgress } = options;

  // Step 1 — microcompact (always cheap, often skips the summariser).
  const microcompacted = microcompactMessages(messages);

  // Step 2 — threshold check. Below threshold: silent fast path; we
  // intentionally do NOT fire `onProgress` so the UI never flashes a
  // "Compacting…" indicator for short conversations.
  const totalTokens = estimateMessagesTokens(microcompacted);
  if (totalTokens <= COMPACTION_THRESHOLD_TOKENS) {
    console.info(
      `[compaction] skipped reason=below_threshold tokens=${totalTokens.toString()} threshold=${COMPACTION_THRESHOLD_TOKENS.toString()}`,
    );
    return microcompacted;
  }

  // Step 3 — full summarisation.
  console.info(
    `[compaction] starting tokens=${totalTokens.toString()} threshold=${COMPACTION_THRESHOLD_TOKENS.toString()} messageCount=${microcompacted.length.toString()}`,
  );
  safeProgress(onProgress, { phase: "started", tokensBefore: totalTokens });
  const summary = await summariseMessages(microcompacted);

  if (summary === null) {
    console.warn(
      `[compaction] summariser_failed tokens=${totalTokens.toString()} returning_microcompacted_history`,
    );
    safeProgress(onProgress, { phase: "failed", tokensBefore: totalTokens });
    return microcompacted;
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
      compactedMessageCount: microcompacted.length,
      estimatedTokensBefore: totalTokens,
      estimatedTokensAfter: 0, // updated below
      createdAt: new Date().toISOString(),
    } satisfies CompactionSummaryMetadata,
  };

  const replayMessage = buildSyntheticActivationReplayMessage(
    runtimeState.activatedTools,
  );

  const compacted: UIMessage[] = replayMessage
    ? [summaryMessage, replayMessage]
    : [summaryMessage];

  const tokensAfter = estimateMessagesTokens(compacted);
  // Patch the metadata in place — the message is still ours, no
  // sharing concerns. Doing it post-hoc avoids a double-estimation.
  const md = summaryMessage.metadata as CompactionSummaryMetadata;
  md.estimatedTokensAfter = tokensAfter;

  const reductionPct =
    totalTokens > 0 ? Math.round((1 - tokensAfter / totalTokens) * 100) : 0;
  console.info(
    `[compaction] succeeded tokensBefore=${totalTokens.toString()} tokensAfter=${tokensAfter.toString()} reduction=${reductionPct.toString()}% summarisedMessages=${microcompacted.length.toString()} activatedToolsPreserved=${runtimeState.activatedTools.length.toString()} pendingTasksMentioned=${runtimeState.pendingTasks.length.toString()}`,
  );
  safeProgress(onProgress, {
    phase: "succeeded",
    tokensBefore: totalTokens,
    tokensAfter,
    reductionPct,
  });

  return compacted;
};
