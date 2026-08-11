import type { Tool, ToolExecuteFunction } from "ai";
import { z } from "zod";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../../lib/tool-error-codes";

/**
 * Force a tool output down to PURE JSON (Date → ISO string, `undefined`
 * props dropped). AI SDK v7 re-validates the assembled ModelMessages
 * against `modelMessageSchema` on EVERY tool-loop step; a live `Date`
 * inside a tool result (e.g. a Postgres timestamp column returned by
 * `querySql`) passes JSON.stringify on the wire but fails that live
 * validation, killing the turn with `InvalidPromptError` at the NEXT
 * step (classified fatal/schema_validation — the 2026-07-17 ~12% abort
 * regression). Primitives pass through untouched; an unstringifiable
 * output (circular ref) is returned raw — no worse than before.
 */
const toJsonSafeOutput = <TOutput>(result: TOutput): TOutput => {
  if (result === null || typeof result !== "object") return result;
  try {
    // JSON.parse is typed `any`; the round-trip preserves the declared
    // output shape for JSON-compatible values. Same sanctioned escape
    // hatch as `injectCaptionField` below.
    return JSON.parse(JSON.stringify(result)) as TOutput;
  } catch (err) {
    console.error("[chatbot-tool] output not JSON-serializable", err);
    return result;
  }
};

/**
 * Wrap a tool's `execute` so an UNEXPECTED throw (or promise rejection)
 * becomes a canonical `ToolErrorOutput` the model reads as a normal result,
 * instead of a raw stream error. Tools still RETURN `{ error, code }` for
 * expected failures — this is the backstop for the unexpected ones, making
 * the "never throw" convention a guarantee. Resolved outputs are forced to
 * pure JSON (`toJsonSafeOutput`). Streaming (async-iterable) results are
 * passed through untouched.
 */
const guardToolExecute = <TInput, TOutput, TContext>(
  execute: ToolExecuteFunction<TInput, TOutput, TContext>,
): ToolExecuteFunction<TInput, TOutput, TContext> => {
  const internalError = (): ToolErrorOutput =>
    toolError(
      TOOL_ERROR_CODES.INTERNAL_ERROR,
      "The tool hit an unexpected internal error. Retry once; if it persists, tell the user this action is temporarily unavailable.",
    );
  const guarded: ToolExecuteFunction<
    TInput,
    TOutput | ToolErrorOutput,
    TContext
  > = (input, options) => {
    let result: AsyncIterable<TOutput> | PromiseLike<TOutput> | TOutput;
    try {
      result = execute(input, options);
    } catch (err) {
      console.error("[chatbot-tool] uncaught error in tool execute", err);
      return Promise.resolve(internalError());
    }
    // Streaming tool result — pass through (no chatbot tool uses this today).
    if (
      result !== null &&
      typeof result === "object" &&
      Symbol.asyncIterator in result
    ) {
      return result;
    }
    return Promise.resolve(result).then(toJsonSafeOutput, (err: unknown) => {
      console.error("[chatbot-tool] rejected promise in tool execute", err);
      return internalError();
    });
  };
  // The AI SDK types `Tool["execute"]` invariantly in OUTPUT; the guard only
  // adds a `ToolErrorOutput` runtime return on unexpected failure, which is
  // serialised opaquely downstream. Same sanctioned escape hatch as
  // `injectCaptionField` below.
  return guarded as unknown as ToolExecuteFunction<TInput, TOutput, TContext>;
};

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

export type ChatbotToolCategory = "core" | "domain";

/**
 * Input shape accepted by `buildChatbotTool`. Extends a Vercel AI SDK
 * `Tool` with the metadata fields whose defaults we want to fill in
 * centrally. `isReadOnly` and `microcompactable` are optional at the
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
  isReadOnly: boolean;
  microcompactable: boolean;
  shouldDefer: boolean;
};

/**
 * User-visible caption field injected into every chatbot tool's input
 * schema by `buildChatbotTool`. The model fills it on each call; the
 * frontend renders it as the live action label (header of
 * `ChatStepGroup` + body of `ChatStepTool`) instead of a static i18n
 * label. See `<tool_captions>` in `chatbot/system-prompt.md` for the
 * instruction the model follows when generating it.
 *
 * Declared `.catch("")`, NOT `.optional()`. The model must keep seeing it as
 * REQUIRED — it stays in the JSON-schema `required` list (an earlier optional
 * version was dropped ~90% of the time on long chains), so the model is
 * maximally incited to send one on every call. But `.catch` makes runtime
 * parsing tolerant: a missing/invalid caption recovers to "" instead of
 * failing the whole tool call with a validation error + wasted error→retry
 * cycles (observed: weaker instruction-followers like MiniMax M3 intermittently
 * omit it). When it's "" the frontend shows its static-label fallback — but the
 * model is never told that, so the description below stays unconditionally
 * imperative.
 */
const CAPTION_FIELD = z
  .string()
  .min(1)
  .catch("")
  .describe(
    "Short user-visible caption (4-8 words, present continuous) describing what you are doing RIGHT NOW. Match the user's last-message language exactly — French → 'Lecture de la facture', English → 'Reading the invoice'. Never default to English when the user wrote in another language. This is the ONLY thing the user sees while the tool runs — REQUIRED on every call; never omit, even on repeated similar calls (each gets its own distinct caption).",
  );

/**
 * Runtime extension of a tool's `inputSchema` with the shared
 * `caption` field. Every chatbot tool declares its inputSchema as a
 * `z.object({...})`, so the Zod v3/v4 `.extend(...)` contract is
 * available — we detect it via duck-typing on the `extend` method
 * rather than re-importing `ZodObject` (the AI SDK widens the field
 * to `FlexibleSchema<INPUT>` which loses the concrete Zod type).
 *
 * The TypeScript `TInput` is intentionally left untouched: tools'
 * `execute(input, options)` keep their original input typing, the
 * caption field is just an extra wire-level field the model can fill
 * and the frontend can read. Tools never need to look at it.
 */
const injectCaptionField = <TSchema>(schema: TSchema): TSchema => {
  if (
    !schema ||
    typeof schema !== "object" ||
    !("shape" in schema) ||
    typeof (schema as { shape: unknown }).shape !== "object" ||
    !("extend" in schema) ||
    typeof (schema as { extend: unknown }).extend !== "function"
  ) {
    return schema;
  }
  // Build a NEW ZodObject with `caption` declared FIRST, then spread
  // the original shape on top. Field declaration order matters: the
  // model tends to emit JSON keys in the order they appear in the
  // schema, so placing caption first means it streams to the client
  // first — the frontend can show "Reading the invoice…" within the
  // first 50-100 ms of the tool call instead of waiting for the
  // entire input JSON to land. The previous `extend({caption})`
  // appended it last and the caption often only arrived just before
  // `tool-input-available`.
  const objectSchema = schema as unknown as {
    shape: Record<string, z.ZodTypeAny>;
  };
  return z.object({
    caption: CAPTION_FIELD,
    ...objectSchema.shape,
  }) as unknown as TSchema;
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
 *
 * Caption injection: the input schema is automatically prepended
 * with a required `caption` field so every tool call carries a
 * short user-visible action label. The model is instructed (in the
 * system prompt) to fill it in the user's language. The execute
 * function ignores the field through ordinary destructuring.
 */
export const buildChatbotTool = <TInput, TOutput>(
  definition: ChatbotToolDefinition<TInput, TOutput>,
): ChatbotTool<TInput, TOutput> => {
  const isReadOnly = definition.isReadOnly ?? true;
  const enrichedDefinition = {
    ...definition,
    inputSchema: injectCaptionField(definition.inputSchema),
    execute: definition.execute
      ? guardToolExecute(definition.execute)
      : undefined,
  };
  const resolved: ChatbotTool<TInput, TOutput> = {
    ...enrichedDefinition,
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
  // v7 widens `Tool.description` to `string | ((options) => string)`. Fretik
  // tools always use a plain string; readers (searchTools) coerce non-strings
  // to "" so the search index stays a string. Mirroring the SDK type here lets
  // a concrete tool registry be passed where a `SearchableToolRegistry` is
  // expected without narrowing every call site.
  description?: ChatbotTool["description"];
  searchHint: string;
  category: ChatbotToolCategory;
}

export type SearchableToolRegistry = Record<string, SearchableTool>;
