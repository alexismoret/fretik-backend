/**
 * The agent's window, assembled — the one door every long-loop agent goes
 * through to read a conversation, and the one that writes its resume point.
 *
 * `@fretik/shared` owns the rows; this module owns what a MODEL sees, which is
 * why the summary and the activation replay are rebuilt here rather than in
 * the storage layer. Having exactly one door matters more than where it sits:
 * a caller that loaded the rows and forgot to prepend the checkpoint would
 * silently drop the entire history before the cut, and a caller that forgot
 * the activation replay would quietly fall back to the base tool set and
 * re-run `searchTools` every turn. Both are invisible in a diff and expensive
 * in production, so neither is left to the caller.
 */

import {
  CHECKPOINT_REPAIR_ROW_LIMIT,
  MAX_CHECKPOINT_GENERATION,
  writeCheckpoint,
} from "@fretik/shared/services/ai/checkpoints";
import { isTurnDiscarded } from "@fretik/shared/services/ai/discarded-turns";
import {
  type AgentWindow,
  type CutAnchor,
  loadConversationForAgent,
  loadRawMessagesBelow,
} from "@fretik/shared/services/ai/messages";
import type { UIMessage } from "ai";
import { parseIntEnv } from "../../agents/shared/env";
import type { ModelProfile } from "../../lib/model-registry/types";
import { type CompactionArtifact, compactConversation } from "./compact";
import { getCompactUserSummaryMessage } from "./prompt";
import {
  buildSyntheticActivationReplayMessage,
  extractRuntimeState,
  formatRuntimeStateForSummary,
} from "./runtime-state-attachments";
import { summariseMessages } from "./summarizer";

export interface AgentWindowResult extends AgentWindow {
  /**
   * `[summary?, activationReplay?, ...rows]` — what the turn feeds the model.
   *
   * TWO messages, not one, whenever tools had been activated before the cut.
   * Emitting only the summary rebuilds the prose and drops the world state
   * with it.
   */
  messages: UIMessage[];
  /**
   * Still aligned 1:1 with `messages`, which is the only reason a caller can
   * turn "the compaction kept N trailing messages" into a row to cut at. The
   * prepended summary and activation replay have no row of their own, so they
   * anchor at `null` — and a tail long enough to reach them therefore yields no
   * cut at all, which is the correct refusal rather than a silent off-by-two.
   */
  anchors: (CutAnchor | null)[];
  /** Generation a checkpoint written after this turn must carry. */
  nextGeneration: number;
}

/**
 * How many rows after the checkpoint one turn will carry — a guard, not the
 * bound that shapes the window. Tokens do that: compaction fires at the cap
 * (~150 000 on the chat model) and folds what it covers into a checkpoint.
 *
 * It was 30 until 2026-09-23, and 30 rows is ~15 exchanges — far below any
 * token cap, so on ordinary chat the ROW bound fired first. Two costs, both
 * measured. The window slid two rows a turn, so the history's cache was lost
 * on every turn past row 30: 19 % of production turn boundaries, 13.5 % of
 * the chat bill over 7 days, and a probe on an 80-row conversation read the
 * same 22 400 cached tokens — the static prefix — on four turns running.
 * And the rows that slid out were never summarised, since compaction only
 * sees the window: a fact stated in the oldest of 40 exchanges was answered
 * "no longer visible" 3 times out of 3, 60 000 tokens below the cap.
 *
 * At 500 the token cap fires first unless rows average under 300 tokens.
 * Past it the old behaviour returns — rows slide out unsummarised — which is
 * why reaching it is logged. The env override exists to roll back without a
 * deploy; below 30 is refused, since that would lose history outright.
 */
export const AGENT_WINDOW_ROW_LIMIT = parseIntEnv("AGENT_WINDOW_ROW_LIMIT", {
  fallback: 500,
  min: 30,
  max: 5000,
});

/**
 * Load a conversation the way an agent must read it.
 *
 * `limit` bounds the rows AFTER the checkpoint, not the conversation: the two
 * bounds answer different questions, and keeping both is what stops a
 * conversation that ran away between two checkpoints from arriving whole.
 */
export const loadAgentWindow = async (
  conversationId: string,
  limit = AGENT_WINDOW_ROW_LIMIT,
): Promise<AgentWindowResult> => {
  const window = await loadConversationForAgent(conversationId, limit);
  // Approximate by one or two rows — a stale partial row is dropped after the
  // limit applies — which is precise enough for a warning.
  if (window.messages.length >= limit) {
    console.warn(
      `[agent-window] row guard reached conversation=${conversationId} rows=${window.messages.length.toString()} limit=${limit.toString()}: older rows after the checkpoint are neither loaded nor summarised`,
    );
  }
  const { checkpoint } = window;
  if (!checkpoint) {
    return { ...window, nextGeneration: 1 };
  }

  const summaryMessage: UIMessage = {
    // Derived from the checkpoint id, never random: this message is re-emitted
    // on every subsequent turn, and a fresh id would rewrite the cached prefix
    // each time.
    id: `compaction-summary-${checkpoint.id}`,
    role: "user",
    // The stored text is the ASSEMBLED handoff message, exactly as the turn
    // that wrote it used — not the raw summariser output. Re-deriving it here
    // would make the bytes depend on the current code rather than on what was
    // agreed at the cut, and a prompt prefix that changes under a deploy is a
    // cache miss on every open conversation.
    parts: [{ type: "text", text: checkpoint.summary }],
    metadata: {
      type: "compaction_summary",
      checkpointId: checkpoint.id,
      generation: checkpoint.generation,
      kind: checkpoint.kind,
    },
  };

  const replayMessage = buildSyntheticActivationReplayMessage(
    checkpoint.activatedTools,
    checkpoint.id,
  );

  const prefix: UIMessage[] = replayMessage
    ? [summaryMessage, replayMessage]
    : [summaryMessage];

  return {
    ...window,
    messages: [...prefix, ...window.messages],
    anchors: [...prefix.map(() => null), ...window.anchors],
    nextGeneration: checkpoint.generation + 1,
  };
};

/**
 * Re-summarise from the RAW rows, resetting the generation chain.
 *
 * Past `MAX_CHECKPOINT_GENERATION` each new checkpoint is a summary of a
 * summary N times over, and nothing of the original wording survives — the
 * property Anthropic and OpenAI share and document no way out of. What we have
 * that they do not is the raw rows: `up_to_message_id` is a foreign key, so
 * nothing under a checkpoint is ever deleted and a repair is always available.
 *
 * It runs HERE, in the fire-and-forget writer, and not in the turn: the turn
 * already has a perfectly usable window, and making a user wait on a second
 * summariser call to fix an artefact they cannot see would be the wrong trade.
 * Returns `null` when the summariser fails, and the caller then writes the
 * ordinary (degraded, higher-generation) checkpoint rather than none at all —
 * a missing checkpoint costs far more than a tired one.
 */
const rebuildFromRaw = async (
  conversationId: string,
  upToSeq: number,
  teamId: string | undefined,
): Promise<{ summary: string; activatedTools: string[] } | null> => {
  const raw = await loadRawMessagesBelow(
    conversationId,
    upToSeq,
    CHECKPOINT_REPAIR_ROW_LIMIT,
  );
  if (raw.length === 0) return null;
  const summary = await summariseMessages(raw, teamId);
  if (summary === null) return null;
  const runtimeState = extractRuntimeState(raw);
  return {
    summary: getCompactUserSummaryMessage(
      summary,
      formatRuntimeStateForSummary(runtimeState),
    ),
    activatedTools: runtimeState.activatedTools,
  };
};

/**
 * Compact AFTER the turn instead of in front of the next one.
 *
 * The wait this removes is the whole point. A conversation that crosses the
 * cap used to pay for it at the worst possible moment: the user sends a
 * message, and before a single token comes back the summariser reads 100 000
 * tokens and writes 3 000 — 20 to 50 seconds of a blank screen, measured. The
 * checkpoint already made that a once-per-cut cost rather than once-per-message,
 * but once is still once, and it lands on somebody who is waiting.
 *
 * Nothing about the summariser needs to happen then. The turn that crossed the
 * cap has already run; what needs a smaller history is the turn AFTER it, and
 * that one has not been asked for yet. So the same call runs here, once the
 * answer has committed, against the same cap — same threshold, same number of
 * compactions, same summariser bill (each one reads only what accumulated
 * since the last, so the total over a conversation is the conversation) — and
 * by the time the next message arrives the checkpoint is already written and
 * the window is two thousand tokens.
 *
 * The synchronous path in the handler stays, and stays reachable: a user who
 * replies within the twenty seconds this takes, a replica that died mid-write,
 * a summariser that was down. It is now the exception rather than the rule,
 * which is the only difference — and the difference the person waiting sees.
 *
 * Never throws: it is called fire-and-forget from a turn that has already
 * finished, and an unhandled rejection there reaches the process under Bun.
 *
 * ## Most calls do nothing, and the tracing depends on that
 *
 * This runs after EVERY turn; only the ones that have just crossed the cap
 * reach a summariser. So the Langfuse `compaction` observation is opened
 * inside `compactConversation`, below its threshold check, and not around this
 * function — wrapping it here filed one empty `compaction` root per turn,
 * which buries the handful that did real work under thousands that did none.
 * `traceSessionId` is what carries the conversation down to it.
 */
export const compactAheadOfNextTurn = async (input: {
  conversationId: string;
  /** Serving model — decides the window the threshold derives from. */
  profile: ModelProfile;
  /** The cap the next turn would apply. Passed rather than re-derived so the
   *  two paths cannot drift apart by one prefix. */
  capTokens: number;
  participantIds: string[];
  teamId?: string;
  /** Turn that produced the rows — a discarded turn must not checkpoint. */
  turnId?: string;
  logPrefix: string;
}): Promise<void> => {
  try {
    // RELOADED, not reused: the turn's own answer committed after the window
    // it read, and a cut that excludes it would leave the next window carrying
    // both a summary and the messages the summary already covers.
    const window = await loadAgentWindow(input.conversationId);
    // No threshold test of our own here, deliberately: `compactConversation`
    // owns it, and a second copy would be a clause no test can kill —
    // below the cap it returns without ever calling `onCompacted`, so the
    // `null` below is the same answer by a shorter route. What this call MUST
    // forward is the cap itself: without it the threshold falls back to the
    // window-derived figure, which on a wide-window model is past 170 000 and
    // would let a conversation grow for hours before anything fired.
    //
    // A holder rather than a `let`: the assignment happens inside a callback,
    // and control-flow analysis would otherwise narrow the variable to `null`
    // at the read below and reject every field access on it.
    const held: { artifact: CompactionArtifact | null } = { artifact: null };
    await compactConversation(window.messages, {
      profile: input.profile,
      maxThresholdTokens: input.capTokens,
      traceSessionId: input.conversationId,
      ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
      onCompacted: (artifact) => {
        held.artifact = artifact;
      },
    });
    const produced = held.artifact;
    // Below the cap, or the summariser produced nothing usable —
    // `compactConversation` has already logged which, in the vocabulary the
    // rest of the compaction logs use.
    if (produced === null) return;

    console.info(
      `${input.logPrefix} compacted ahead of the next turn: ${produced.tokensBefore.toString()} → ${produced.tokensAfter.toString()} tokens, so the next one opens on a checkpoint`,
    );
    await persistCheckpoint({
      conversationId: input.conversationId,
      window,
      summary: produced.summary,
      activatedTools: produced.activatedTools,
      participantIds: input.participantIds,
      kind: "llm",
      tokensBefore: produced.tokensBefore,
      tokensAfter: produced.tokensAfter,
      keptTailCount: produced.keptTailCount,
      ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });
  } catch (err) {
    console.warn(
      `${input.logPrefix} compaction ahead of the next turn failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export interface CheckpointWriteInput {
  conversationId: string;
  window: AgentWindowResult;
  /** The assembled handoff text, byte-for-byte as the turn used it. */
  summary: string;
  activatedTools: string[];
  participantIds: string[];
  kind: "llm" | "mechanical" | "truncated";
  tokensBefore: number;
  tokensAfter: number;
  /**
   * Trailing messages of the window the summary does NOT cover, straight from
   * the `CompactionArtifact`. The cut moves back by exactly this many so the
   * next window reloads them from their rows — which is what makes a verbatim
   * tail cost nothing to store: it is never copied, only left uncut.
   */
  keptTailCount: number;
  /** Turn that produced it — a discarded turn must not write. */
  turnId?: string;
  /** Summariser model pick for the repair path. */
  teamId?: string;
}

/**
 * The row a checkpoint anchors on, given how much of the window stayed
 * verbatim.
 *
 * Reading the anchor at the head's last index is the whole translation: the
 * window's messages and its anchors are the same list seen twice, compaction
 * preserves length and order, so "the summary covered everything but the last
 * N" and "cut at the row under index length − N − 1" are the same statement.
 * Out of range, or under the synthetic prefix, answers `null` — no cut, no
 * checkpoint, and the conversation simply carries one more window.
 */
const cutForTail = (
  window: AgentWindowResult,
  keptTailCount: number,
): CutAnchor | null =>
  window.anchors[window.anchors.length - 1 - keptTailCount] ?? null;

/**
 * Persist a checkpoint for a turn that has just finished. Never throws.
 *
 * Three guards, and each one closes a hole the others do not:
 *
 *  - **the cut comes from the window**, and from the part of it the summary
 *    actually covers, so both the answer this very turn produced (persisted by
 *    `onFinish` at a higher `seq`) and the verbatim tail stay outside the
 *    summary and inside the next window;
 *  - **a discarded turn writes nothing** — `rewind` deletes the rows while the
 *    dying turn is still running, and without this check it would commit a
 *    summary of the exchange the user has just erased. `turn-recorder.ts`
 *    takes the same precaution for the same reason;
 *  - **the write cannot reject into the void** — an unhandled rejection on a
 *    fire-and-forget promise reaches the process level under Bun, which turns
 *    a failed optimisation into a crashed service.
 */
export const persistCheckpoint = async (
  input: CheckpointWriteInput,
): Promise<void> => {
  const cut = cutForTail(input.window, input.keptTailCount);
  if (!cut) {
    console.info(
      `[checkpoint] skipped reason=no_settled_row conversation=${input.conversationId} keptTail=${input.keptTailCount.toString()}`,
    );
    return;
  }
  try {
    if (input.turnId && (await isTurnDiscarded(input.turnId))) {
      console.info(
        `[checkpoint] skipped reason=turn_discarded conversation=${input.conversationId}`,
      );
      return;
    }
    // Past the cap, try to start a fresh chain from the raw rows. A failed
    // repair degrades to the ordinary write — never to no write at all.
    const repaired =
      input.window.nextGeneration > MAX_CHECKPOINT_GENERATION
        ? await rebuildFromRaw(input.conversationId, cut.seq, input.teamId)
        : null;
    const generation = repaired ? 1 : input.window.nextGeneration;

    const written = await writeCheckpoint({
      conversationId: input.conversationId,
      upToMessageId: cut.messageId,
      upToSeq: cut.seq,
      summary: repaired?.summary ?? input.summary,
      activatedTools: repaired?.activatedTools ?? input.activatedTools,
      participantIds: input.participantIds,
      generation,
      kind: input.kind,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
    });
    console.info(
      `[checkpoint] ${written ? "written" : "already_present"} conversation=${input.conversationId} upToSeq=${cut.seq.toString()} keptTail=${input.keptTailCount.toString()} generation=${generation.toString()}${repaired ? " repaired=raw" : ""} kind=${input.kind} tokensBefore=${input.tokensBefore.toString()} tokensAfter=${input.tokensAfter.toString()}`,
    );
  } catch (err) {
    // A rewind landing between the guard and the insert deletes the anchor row
    // and the foreign key refuses the write — which is the correct outcome,
    // reached by the database rather than by a check. Not an error path worth
    // failing a turn over.
    console.warn(
      `[checkpoint] write_failed conversation=${input.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
