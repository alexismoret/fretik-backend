import type { UIMessage } from "ai";

/**
 * Runtime-state attachments — Fretik's equivalent of Claude Code's
 * `createPlanAttachmentIfNeeded` + `createSkillAttachmentIfNeeded`
 * (`compact.ts:1466+`).
 *
 * Audit of the Fretik codebase showed that almost every "file"
 * (persisted-output, uploaded attachments, drive downloads, sandbox
 * filesystem, context files) survives compaction without any
 * dedicated attachment, because:
 *   - The files themselves persist in E2B / Postgres / S3 (external
 *     to the message history), and
 *   - The system prompt rebuilders (`buildAttachedFilesBlock`,
 *     `buildChatbotContextManifest`) reconstruct the file index from
 *     scratch on every turn.
 *
 * The one piece that DOES live in the message history and would be
 * lost without explicit help is `DynamicToolManager.activatedTools` —
 * reconstructed from past `searchTools` tool-result payloads by
 * `replayActivationFromHistory`. After full compaction, those
 * payloads are gone.
 *
 * This module:
 *   - Extracts that state from a `UIMessage[]` history.
 *   - Formats it as a plain-text block to be appended to the
 *     compaction summary (`getCompactUserSummaryMessage`).
 *   - Synthesises a fake `tool-searchTools` UIMessage that preserves
 *     activatedTools through `convertToModelMessages` so the existing
 *     `replayActivationFromHistory` (in `agents/shared/dynamic-tools.ts`)
 *     finds the cumulative activation set after compaction WITHOUT
 *     any change to that function. The synthetic message is the
 *     only post-compact mechanism that actually drives runtime state;
 *     the text block in the summary is for the model's awareness only.
 *
 * @see agents/shared/dynamic-tools.ts
 * @see claude-code/src/services/compact/compact.ts createPlanAttachmentIfNeeded
 */

const TOOL_PART_PREFIX = "tool-";
const SEARCH_TOOLS_PART_TYPE = "tool-searchTools";

export interface RuntimeStateSnapshot {
  /**
   * Cumulative set of domain tool names the model has activated via
   * past `searchTools` calls, in first-encounter order. May be empty
   * for short / pure-Q&A conversations.
   */
  activatedTools: string[];
}

/**
 * Type guard for the structured payload returned by `searchTools.execute`
 * (`tools/search-tools.ts::execute`). Mirrors the shape inspected by
 * `replayActivationFromHistory` so we extract the same cumulative set.
 */
const extractMatchesFromSearchToolsOutput = (
  output: unknown,
): string[] | null => {
  if (output === null || output === undefined) return null;
  if (typeof output !== "object" || Array.isArray(output)) return null;
  const maybeMatches = (output as { matches?: unknown }).matches;
  if (!Array.isArray(maybeMatches)) return null;
  const names = maybeMatches.filter((n): n is string => typeof n === "string");
  return names;
};

/**
 * Walk the conversation messages and extract the cumulative
 * activated-tool set. Activated tools accumulate across every
 * `searchTools` result encountered (mirrors `replayActivationFromHistory`).
 */
export const extractRuntimeState = (
  messages: UIMessage[],
): RuntimeStateSnapshot => {
  const activated = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.parts)) continue;
    for (const part of msg.parts) {
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
      if (!("state" in part) || part.state !== "output-available") continue;
      const output = "output" in part ? part.output : undefined;

      if (part.type === SEARCH_TOOLS_PART_TYPE) {
        const matches = extractMatchesFromSearchToolsOutput(output);
        if (matches) {
          for (const name of matches) activated.add(name);
        }
      }
    }
  }

  return {
    activatedTools: [...activated],
  };
};

/**
 * Render a runtime-state snapshot as plain text to append after the
 * summary in `getCompactUserSummaryMessage`. Returns an empty string
 * when there is nothing useful to inject — the caller checks
 * `length > 0` before appending.
 */
export const formatRuntimeStateForSummary = (
  state: RuntimeStateSnapshot,
): string => {
  if (state.activatedTools.length === 0) return "";
  return `Active domain tools (already unlocked via searchTools — call them directly without re-running searchTools): ${state.activatedTools.join(", ")}`;
};

/**
 * Build a synthetic assistant `UIMessage` that re-asserts the cumulative
 * activated-tool set, so `convertToModelMessages` produces a
 * `searchTools` tool-result message that
 * `replayActivationFromHistory` (in `agents/shared/dynamic-tools.ts`)
 * picks up unchanged.
 *
 * Returns `null` when there is nothing to assert (no tools were ever
 * activated). The caller skips the message in that case to avoid
 * polluting the post-compact history with a no-op.
 *
 * Why a UIMessage with a `tool-searchTools` part: at the chatbot
 * handler boundary we work in UIMessage space; the AI SDK's
 * `convertToModelMessages` then splits this into the standard
 * `assistant` (tool-call) + `tool` (tool-result) ModelMessage pair.
 * That pair is exactly what the existing replay function scans for —
 * no changes needed in dynamic-tools.ts.
 *
 * The synthesized `query` mirrors the `select:A,B,C` form used by
 * real `searchTools` calls so logs and any human inspecting the
 * persisted message history can tell what happened.
 */
export const buildSyntheticActivationReplayMessage = (
  activatedTools: string[],
): UIMessage | null => {
  if (activatedTools.length === 0) return null;

  const toolCallId = `compaction-replay-${crypto.randomUUID()}`;
  const query = `select:${activatedTools.join(",")}`;

  // Cast through `unknown` to satisfy the AI SDK's discriminated-union
  // generic on `UIMessage`. The shape below matches `ToolUIPart` with
  // `state: "output-available"` exactly — see node_modules/ai's
  // `UIToolInvocation`. We can't construct it via the typed factory
  // (no public constructor) so the safest path is a runtime-shaped
  // object validated by hand.
  const part = {
    type: SEARCH_TOOLS_PART_TYPE,
    toolCallId,
    state: "output-available" as const,
    input: { query },
    output: {
      matches: [...activatedTools],
      query,
      total_deferred_tools: activatedTools.length,
    },
  };

  const message: UIMessage = {
    id: `compaction-replay-${crypto.randomUUID()}`,
    role: "assistant",
    parts: [part] as UIMessage["parts"],
  };

  return message;
};
