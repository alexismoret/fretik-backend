import type { Tool } from "ai";

/**
 * Shared tool metadata used by the chatbot agent.
 *
 * Every tool the chatbot can call is built through `buildChatbotTool` so
 * we have a single place that enforces category rules, default result
 * size limits, and the Progressive Disclosure contract.
 *
 * - `core` tools are always loaded in the initial `streamText()` call.
 * - `domain` tools are listed by name in the system prompt but only
 *   injected after the model activates them via `searchTools`. They
 *   carry `shouldDefer: true` so the dynamic tool manager can pick
 *   them up.
 */

/**
 * Default cap on how many characters a tool result can return before
 * the persisted-output layer swaps the full payload for a filesystem
 * reference + preview. Chosen at 32K (~8K tokens) — small enough to
 * stay within the context budget of non-Anthropic models, large
 * enough to cover most real tool turns.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 32_000;

export type ChatbotToolCategory = "core" | "domain";

/**
 * Input shape accepted by `buildChatbotTool`. Extends a Vercel AI SDK
 * `Tool` with the metadata fields whose defaults we want to fill in
 * centrally. `maxResultSizeChars` and `isReadOnly` are optional at the
 * call site so tool authors only specify them when they deviate from
 * the defaults.
 */
export type ChatbotToolDefinition<TInput, TOutput> = Tool<TInput, TOutput> & {
  category: ChatbotToolCategory;
  /**
   * Short hint (3–10 words) describing what the tool does. Concatenated
   * with `name` + `description` for keyword scoring inside `searchTools`.
   * Keep it dense and noun-heavy.
   */
  searchHint: string;
  /** Override the default 32K cap. Only set when the tool really needs it. */
  maxResultSizeChars?: number;
  /** Defaults to `true` — all current chatbot tools are read-only. */
  isReadOnly?: boolean;
  /**
   * When true, microcompact (`services/compaction/microcompact.ts`) may
   * replace this tool's older `output-available` results with a marker
   * to free context space. Defaults to `isReadOnly` — read-only tools
   * are safe to clear because the model can re-fetch the same payload
   * by re-calling the tool with the same args.
   *
   * Set explicitly to `false` ONLY when:
   *   - The tool is read-only BUT the JSON payload carries replay-
   *     critical state (e.g. `searchTools`, whose result drives
   *     `replayActivationFromHistory`).
   *   - The output is a one-shot, non-recoverable artifact whose path
   *     would be lost if cleared.
   *
   * Set explicitly to `true` ONLY when the tool is `isReadOnly: false`
   * (because of an external API call or similar non-local effect) but
   * the result is conceptually stateless / re-fetchable, e.g. a vision
   * model that returns a description.
   */
  microcompactable?: boolean;
};

/**
 * Fully resolved chatbot tool. All metadata fields are required and
 * `shouldDefer` is derived from `category`, so downstream code can
 * trust it without re-checking the rule.
 */
export type ChatbotTool<TInput = unknown, TOutput = unknown> = Tool<
  TInput,
  TOutput
> & {
  category: ChatbotToolCategory;
  searchHint: string;
  maxResultSizeChars: number;
  isReadOnly: boolean;
  microcompactable: boolean;
  shouldDefer: boolean;
};

/**
 * Wraps a `Tool` definition with chatbot metadata, filling in defaults
 * and enforcing the invariant `shouldDefer === (category === 'domain')`.
 *
 * Call sites keep the familiar `tool({...})` shape but add the three
 * metadata fields inline, e.g.:
 *
 *     buildChatbotTool({
 *       category: "core",
 *       searchHint: "semantic rag documents",
 *       description: "...",
 *       inputSchema: z.object({ question: z.string() }),
 *       execute: async ({ question }) => { ... },
 *     })
 */
export const buildChatbotTool = <TInput, TOutput>(
  definition: ChatbotToolDefinition<TInput, TOutput>,
): ChatbotTool<TInput, TOutput> => {
  const isReadOnly = definition.isReadOnly ?? true;
  const resolved: ChatbotTool<TInput, TOutput> = {
    ...definition,
    maxResultSizeChars:
      definition.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS,
    isReadOnly,
    microcompactable: definition.microcompactable ?? isReadOnly,
    shouldDefer: definition.category === "domain",
  };
  return resolved;
};

/** Narrowed tool set used by the chatbot. */
export type ChatbotToolSet = Record<string, ChatbotTool>;

/**
 * Minimal shape that `searchTools` and `prepareStep` need from a tool
 * registry: the fields they actually read. Using this instead of
 * `ChatbotToolSet` at function boundaries sidesteps the AI SDK's
 * invariance on `Tool<TInput, TOutput>` generics — callers can pass
 * the concrete, strongly-typed result of `buildDomainTools(ctx)`
 * directly without widening to `ChatbotTool<unknown, unknown>`, which
 * TypeScript refuses because the invariant positions of `inputSchema`
 * forbid it.
 */
export interface SearchableTool {
  description?: string;
  searchHint: string;
  category: ChatbotToolCategory;
}

export type SearchableToolRegistry = Record<string, SearchableTool>;
