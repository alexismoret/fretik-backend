import type { ModelMessage } from "ai";

/**
 * Per-conversation state manager for Progressive Disclosure (Phase 2).
 *
 * Domain tools are listed by name in the system prompt but intentionally
 * not injected into the initial agent call. When the model discovers it
 * needs one, it calls the `searchTools` core tool which mutates this
 * manager. On the next step, the chatbot's `prepareStep` (see
 * `agents/chatbot/index.ts`) reads `getSnapshot()` and uses it to
 * compute the `activeTools` array passed to the model.
 *
 * The manager lives for the duration of a single request — the agent's
 * `prepareCall` hook (see `agent-builder.ts`) instantiates a fresh one
 * and stores it on `AgentRuntimeContext.dynamicToolManager`. No global
 * state, no cross-request leakage.
 *
 * Inspired by Claude Code's ToolSearch pattern: the LLM only sees tools
 * it has explicitly asked for, which keeps the context window small
 * while still exposing a large tool catalog.
 */
export class DynamicToolManager {
  private readonly activatedTools = new Set<string>();

  /**
   * Mark one or more domain tool names as active for the rest of this
   * conversation turn. Unknown names are silently ignored — validation
   * happens inside `searchTools` before this method is called, so any
   * name that reaches here has already been checked against the
   * domain tool registry.
   */
  activate(toolNames: readonly string[]): void {
    for (const name of toolNames) {
      this.activatedTools.add(name);
    }
  }

  /**
   * True if `toolName` has already been activated. `searchTools` uses
   * this to skip redundant activations and return an idempotent result
   * when the model calls it twice with the same argument.
   */
  isActivated(toolName: string): boolean {
    return this.activatedTools.has(toolName);
  }

  /**
   * Snapshot of every activated tool name, in insertion order. Safe to
   * pass to `prepareStep` as part of the `activeTools` array.
   */
  getSnapshot(): string[] {
    return [...this.activatedTools];
  }
}

/**
 * Replay activation state from a model-message history.
 *
 * Scans `messages` for past tool results emitted by the gateway tool
 * (`searchTools`) and re-activates every tool name it finds in the
 * `matches` field of the result payload. The point is that activation
 * should survive across user turns inside a single conversation —
 * otherwise every new user message forces the model to re-discover
 * tools it has already used, which is wasteful and gives confused
 * models another chance to hallucinate a direct call to a deferred
 * tool.
 *
 * Mirrors Claude Code's `extractDiscoveredToolNames` pattern (see
 * `claude-code/src/utils/toolSearch.ts` — that one scans message
 * history for `tool_reference` content blocks returned by the
 * Anthropic API after `ToolSearchTool`; Fretik does the equivalent
 * at the AI SDK layer by reading the JSON `matches` we return from
 * `searchTools`).
 *
 * Defensive parsing: messages whose output shape does not match the
 * expected `{ matches: string[] }` contract are silently skipped —
 * a mid-migration history where an older `searchTools` version
 * returned a different shape will not crash the replay.
 */
export const replayActivationFromHistory = (
  manager: DynamicToolManager,
  messages: readonly ModelMessage[],
  gatewayToolName: string,
): void => {
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const part of msg.content) {
      if (part.type !== "tool-result") continue;
      if (part.toolName !== gatewayToolName) continue;
      // `part.output` is a discriminated union; only the `json`
      // variant carries the structured payload we returned from
      // `searchTools.execute`. `text` / `error-text` / other
      // variants are either legacy or error paths — skip them.
      const output = part.output;
      if (output.type !== "json") continue;
      const value = output.value;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const maybeMatches = (value as { matches?: unknown }).matches;
      if (!Array.isArray(maybeMatches)) continue;
      const names = maybeMatches.filter(
        (n): n is string => typeof n === "string",
      );
      if (names.length > 0) manager.activate(names);
    }
  }
};
