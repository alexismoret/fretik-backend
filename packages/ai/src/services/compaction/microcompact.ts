import type { UIMessage } from "ai";
import { buildSubAgentTools } from "../../agents/chatbot/tools";

/**
 * Microcompact — applicative replacement for Claude Code's
 * `microCompact.ts::maybeTimeBasedMicrocompact`.
 *
 * Goal: shrink the conversation history *between turns* by replacing
 * old, stateless tool-results (RAG searches, SQL reads, file reads)
 * with a compact marker so a single user request that fanned out
 * into a dozen tool calls doesn't pin 100K+ tokens of stale tool
 * output in the next turn's context.
 *
 * Why "applicative" rather than CC's `cache_edits` API path: OpenRouter
 * does not expose Anthropic's prompt-cache-edit primitive. Without a
 * cache prefix to preserve, mutating message content directly costs
 * nothing extra (cache breaks anyway), so we run a simple in-memory
 * rewrite on every turn.
 *
 * Run order: ALWAYS BEFORE the threshold-based full compaction. The
 * marker shrinks the token count, which can avoid triggering the
 * heavyweight summariser in the first place.
 *
 * Native media parts (C5) are intentionally NOT aged here. They are not
 * tool results, and `prepareModelMessages` already bounds how many ride a
 * single request via the per-modality recency cap
 * (`nativeInput.limits.max{Images,Videos}PerRequest`), re-resolved fresh
 * every turn against the active profile — so the prompt weight stays
 * bounded regardless of history length. The token estimator costs the
 * surviving native parts so the threshold below stays honest.
 *
 * Trade-off vs CC:
 *   - CC keeps the recent N tool results verbatim AND skips the
 *     mutation when the cache is warm (so the prefix isn't broken).
 *   - Fretik has no cache-warmth signal (OpenRouter), so byte-stability
 *     across turns IS the cache strategy: the function must be a
 *     deterministic, monotone function of the history — same history
 *     prefix in, same cleared bytes out — because the raw history is
 *     re-microcompacted from scratch every turn (nothing is persisted).
 *     Clearing is therefore batched with hysteresis (see
 *     `CLEAR_BATCH_SIZE` / `CLEAR_TAIL_BUDGET_CHARS`) instead of the
 *     original sliding window: a sliding cutoff rewrote 1-2 results at
 *     the head of the history EVERY turn, invalidating the provider
 *     prefix cache for the whole downstream payload. Measured on a
 *     5-turn builder conversation (2026-07-30, gpt-5.6-luna @ $1/M in,
 *     $0.105/M cached): each turn re-billed 58-97k tokens uncached
 *     (~$0.08-0.10) to save ~1.5k tokens of cleared output (~$0.0002) —
 *     wrong by two orders of magnitude on any model with a discounted
 *     prompt cache. With hysteresis the same rewrite happens once per
 *     `CLEAR_BATCH_SIZE` results (or when the stale tail outgrows the
 *     char budget), amortising one prefix bust over many turns.
 *
 * Eligibility — derived from the live tool registry, NOT a hand-
 * maintained list. A tool's result is eligible for clearing iff
 * `tool.microcompactable === true`. That flag defaults to
 * `tool.isReadOnly` in `buildChatbotTool`, so any new read-only tool
 * the team adds is automatically picked up here without code changes
 * in this file. Edge cases (replay-critical tools like `searchTools`,
 * or read-only-from-our-perspective tools with `isReadOnly: false`
 * like `vision`) opt in/out via the explicit `microcompactable`
 * override at the registration site. See
 * `agents/shared/chatbot-tool.ts::ChatbotToolDefinition.microcompactable`
 * for the full contract.
 *
 * Safety contract:
 *   - Only parts in `state === "output-available"` are eligible. In-
 *     flight or errored states are left alone.
 *   - The most recent `KEEP_RECENT_COMPACTABLE_RESULTS` matches stay
 *     verbatim — the model needs at least its immediate working set.
 *   - Returns a NEW array of NEW message objects when anything
 *     changed; the input is never mutated. When nothing matches
 *     (short conversation, no compactable results), returns the input
 *     by reference.
 *
 * @see claude-code/src/services/compact/microCompact.ts
 */

/**
 * Compactable tool names, derived once at module load from the chatbot
 * registry. Authoritative source: `tool.microcompactable === true` on
 * the resolved `ChatbotTool`. Computed lazily inside an IIFE so the
 * registry construction (which itself transitively imports a lot of
 * tooling code) only runs when this module is actually imported by the
 * compaction pipeline — keeps test boot times reasonable.
 *
 * Exported for tests (assertion: `searchTools` is NOT in the set,
 * `read` IS in the set) and for the runtime-state attachments module
 * which needs to know which tools are state-bearing.
 */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = (() => {
  // We use `buildSubAgentTools()` rather than `buildChatbotTools()`
  // here on purpose: the latter requires a `dispatchAgent` argument
  // (built in `agents/chatbot/index.ts` after the sub-agent sets are
  // ready) which would create a circular import for this module. The
  // two registries differ ONLY by `dispatchAgent` + `searchTools`,
  // both of which are explicitly NOT microcompactable, so the
  // resulting `COMPACTABLE_TOOLS` set is identical either way.
  const registry = buildSubAgentTools();
  const names = new Set<string>();
  for (const [name, def] of Object.entries(registry)) {
    if (def.microcompactable) {
      names.add(name);
    }
  }
  return names;
})();

/**
 * Number of most-recent compactable tool results to keep verbatim.
 * Mirrors CC's `getTimeBasedMCConfig().keepRecent` default of 5: the
 * model's immediate working set needs full fidelity; older results
 * are rebuildable on demand via the same tool calls.
 *
 * Env override: `COMPACTION_MICROCOMPACT_KEEP_RECENT`, clamped
 * `[1, 30]`. Floor at 1 because clearing every result leaves the
 * model with zero working context, which is never sensible.
 */
export const KEEP_RECENT_COMPACTABLE_RESULTS = (() => {
  const raw = process.env.COMPACTION_MICROCOMPACT_KEEP_RECENT;
  if (!raw) return 5;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(30, Math.max(1, Math.floor(parsed)));
})();

/**
 * Hysteresis quantum: eligible results are cleared in batches of this
 * size — the cutoff is `floor(eligible / CLEAR_BATCH_SIZE) * CLEAR_BATCH_SIZE`,
 * so the cleared set (and thus the serialized prefix bytes) only changes
 * once every `CLEAR_BATCH_SIZE` new compactable results instead of every
 * turn. Between two batch boundaries at most `CLEAR_BATCH_SIZE - 1` stale
 * results ride along uncleared; they ride at the cached-token rate, which
 * is what makes the wait cheaper than the rewrite.
 */
export const CLEAR_BATCH_SIZE = 10;

/**
 * Size override for the count quantum: when the UNCLEARED eligible tail
 * (everything past the batch cutoff, excluding the keep-recent set)
 * exceeds this many serialized chars (~20k tokens), the cutoff advances
 * past enough of it to get back under budget, batch boundary or not.
 * Guards the original microcompact motivation — a burst of huge RAG/read
 * dumps must not pin 100k+ stale tokens for up to 9 turns. The cutoff
 * derived from this rule is monotone as the history grows (appending
 * results only ever moves it forward), preserving byte-stability of the
 * already-cleared prefix.
 */
export const CLEAR_TAIL_BUDGET_CHARS = 80_000;

const TOOL_PART_PREFIX = "tool-";

/**
 * Marker that replaces a cleared tool result. Includes the tool name +
 * tool call ID so the model can recover the original via persisted-
 * output (the `<persisted-output>` envelope, when present, was emitted
 * earlier in the same message and references `outputs/persisted/{id}`).
 *
 * The marker itself is plain text — the AI SDK accepts a string in the
 * `output` slot of an `output-available` tool part. Same shape used by
 * CC `microCompact.ts::TIME_BASED_MC_CLEARED_MESSAGE`.
 */
const buildClearedMarker = (toolName: string, toolCallId: string): string =>
  `[Old ${toolName} tool result content cleared (tool call ${toolCallId}). If the full output was persisted, it lives at outputs/persisted/${toolCallId}.* — recover it with read("outputs/persisted/${toolCallId}.txt") or read("outputs/persisted/${toolCallId}.json"). Otherwise re-run ${toolName} with the same arguments to fetch fresh data.]`;

interface CompactableHit {
  messageIndex: number;
  partIndex: number;
  toolName: string;
  toolCallId: string;
  /** Serialized size of the part's output, for the tail-budget rule. */
  outputChars: number;
}

/**
 * Walk the message tree once and collect every tool part eligible for
 * clearing, in encounter (chronological) order.
 *
 * Eligibility: `part.type` starts with `tool-<name>` where
 * `<name>` is in `COMPACTABLE_TOOLS`, and `part.state` is
 * `'output-available'` (so the result is finalised — we don't touch
 * in-flight or errored calls).
 */
const collectCompactableHits = (messages: UIMessage[]): CompactableHit[] => {
  const hits: CompactableHit[] = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m];
    if (!msg) continue;
    const parts = msg.parts;
    if (!Array.isArray(parts)) continue;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (
        part === undefined ||
        part === null ||
        typeof part !== "object" ||
        !("type" in part) ||
        typeof part.type !== "string"
      ) {
        continue;
      }
      if (!part.type.startsWith(TOOL_PART_PREFIX)) continue;
      const toolName = part.type.slice(TOOL_PART_PREFIX.length);
      if (!COMPACTABLE_TOOLS.has(toolName)) continue;
      // Type narrowing: tool parts are discriminated by `state`. We
      // only clear `output-available` because that's the only state
      // that holds a final result we can replace without losing
      // information about an in-flight call.
      if (!("state" in part) || part.state !== "output-available") continue;
      const toolCallId =
        "toolCallId" in part && typeof part.toolCallId === "string"
          ? part.toolCallId
          : `unknown-${m.toString()}-${p.toString()}`;
      // Tool outputs come from the persisted history (already went
      // through JSON once), so serialization cannot throw here.
      const serialized =
        "output" in part ? JSON.stringify(part.output) : undefined;
      hits.push({
        messageIndex: m,
        partIndex: p,
        toolName,
        toolCallId,
        outputChars: serialized === undefined ? 0 : serialized.length,
      });
    }
  }
  return hits;
};

/**
 * Replace the older compactable tool-results with markers.
 *
 * The cutoff is deterministic and MONOTONE in the history (appending
 * new results never un-clears an already-cleared one), so consecutive
 * turns serialize a byte-identical prefix until a batch boundary or
 * the tail budget advances it — that invariant is what keeps the
 * provider prompt cache warm across turns.
 *
 * @returns A new `UIMessage[]` with the marker substitutions applied,
 *   or the input array by reference when nothing changed (no hits, or
 *   the hysteresis cutoff is still zero).
 */
export const microcompactMessages = (messages: UIMessage[]): UIMessage[] => {
  const hits = collectCompactableHits(messages);
  if (hits.length <= KEEP_RECENT_COMPACTABLE_RESULTS) {
    return messages;
  }

  const eligible = hits.length - KEEP_RECENT_COMPACTABLE_RESULTS;

  // Count rule: clear in whole batches only.
  const countCutoff =
    Math.floor(eligible / CLEAR_BATCH_SIZE) * CLEAR_BATCH_SIZE;

  // Size rule: if the uncleared eligible tail outweighs the budget,
  // advance the cutoff just past the overflow. Walk backwards from the
  // newest eligible hit accumulating sizes; the first index where the
  // running total exceeds the budget must be cleared, along with
  // everything older.
  let sizeCutoff = 0;
  let tailChars = 0;
  for (let i = eligible - 1; i >= 0; i--) {
    tailChars += hits[i]?.outputChars ?? 0;
    if (tailChars > CLEAR_TAIL_BUDGET_CHARS) {
      sizeCutoff = i + 1;
      break;
    }
  }

  const cutoff = Math.max(countCutoff, sizeCutoff);
  if (cutoff === 0) {
    return messages;
  }
  // Index by message → set of part indices to clear.
  const clearMap = new Map<number, Set<number>>();
  for (let i = 0; i < cutoff; i++) {
    const hit = hits[i];
    if (!hit) continue;
    const set = clearMap.get(hit.messageIndex) ?? new Set<number>();
    set.add(hit.partIndex);
    clearMap.set(hit.messageIndex, set);
  }

  let clearedCount = 0;
  const next = messages.map((msg, m) => {
    const partsToClear = clearMap.get(m);
    if (!partsToClear || partsToClear.size === 0) return msg;
    if (!Array.isArray(msg.parts)) return msg;
    const newParts = msg.parts.map((part, p) => {
      if (!partsToClear.has(p)) return part;
      // Re-narrow inside the map so TS picks the
      // `state: "output-available"` branch of the discriminated
      // union — without re-checking, the spread below sees the
      // wider variant where `output?: never` and the marker string
      // becomes incompatible. `collectCompactableHits` already
      // filtered the indices to this state at runtime, so the
      // checks are guaranteed to pass; they exist here only for the
      // type narrowing.
      if (
        part === undefined ||
        part === null ||
        typeof part !== "object" ||
        !("type" in part) ||
        typeof part.type !== "string" ||
        !part.type.startsWith(TOOL_PART_PREFIX) ||
        !("state" in part) ||
        part.state !== "output-available"
      ) {
        return part;
      }
      const toolName = part.type.slice(TOOL_PART_PREFIX.length);
      const toolCallId =
        "toolCallId" in part && typeof part.toolCallId === "string"
          ? part.toolCallId
          : `unknown-${m.toString()}-${p.toString()}`;
      clearedCount++;
      // Spread preserves toolCallId / state / input / provider
      // metadata; overwrite `output` with the cleared marker.
      return {
        ...part,
        output: buildClearedMarker(toolName, toolCallId),
      };
    });
    return { ...msg, parts: newParts };
  });

  if (clearedCount > 0) {
    console.info(
      `[compaction:microcompact] cleared count=${clearedCount.toString()} keptRecent=${KEEP_RECENT_COMPACTABLE_RESULTS.toString()} totalCompactable=${hits.length.toString()}`,
    );
  }

  return next;
};
