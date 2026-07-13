import type { LanguageModelUsage, UIMessage } from "ai";

/**
 * Shared turn-persistence + telemetry helpers for the chatbot and workflow
 * handlers. Both stream an agent turn, persist the NEW assistant messages, and
 * (now) tag each with the same telemetry blob — this module is the single home
 * for those three near-identical pieces so the two handlers can't drift.
 */

/**
 * Narrow a UIMessage's `unknown` metadata to a plain object for persistence —
 * keeps whatever the `messageMetadata` stream callback attached
 * (`langfuseTraceId`, `telemetry`). Per-turn observability (tool calls, RAG
 * hits, latency, cost) lives in Langfuse, not the DB row.
 */
export const narrowMessageMetadata = (
  m: UIMessage,
): Record<string, unknown> | undefined =>
  m.metadata && typeof m.metadata === "object"
    ? (m.metadata as Record<string, unknown>)
    : undefined;

/**
 * The NEW assistant messages this turn produced — those whose id is not already
 * in the history loaded before the stream started. Shared filter for both
 * handlers' persistence paths.
 */
export const filterNewAssistantMessages = (
  history: UIMessage[],
  finalMessages: UIMessage[],
): UIMessage[] => {
  const known = new Set(history.map((m) => m.id));
  return finalMessages.filter(
    (m) => !known.has(m.id) && m.role === "assistant",
  );
};

/**
 * The finish part of a UI message stream, narrowed to the fields the turn
 * telemetry blob reads. The concrete `toUIMessageStream` finish part carries
 * more — this structural view lets the builder stay handler-agnostic.
 */
interface TurnFinishPart {
  finishReason: string;
  rawFinishReason: string | undefined;
  totalUsage: LanguageModelUsage;
}

/**
 * Build the assistant message's persisted `metadata` from a turn's finish part.
 * `langfuseTraceId` lets the feedback control score the right Langfuse trace;
 * `telemetry` (finish reason + which agent/profile served + token usage) is
 * read by the eval harness over SSE. One shape for the chatbot's primary and
 * fallback streams AND the workflow turn, so persisted messages carry identical
 * telemetry everywhere.
 */
export const buildTurnMessageMetadata = (
  part: TurnFinishPart,
  servedBy: "primary" | "fallback",
  modelProfileKey: string,
  traceId: string | undefined,
): Record<string, unknown> => ({
  ...(traceId !== undefined ? { langfuseTraceId: traceId } : {}),
  telemetry: {
    finishReason: part.finishReason,
    rawFinishReason: part.rawFinishReason,
    servedBy,
    modelProfileKey,
    usage: {
      inputTokens: part.totalUsage.inputTokens,
      outputTokens: part.totalUsage.outputTokens,
      totalTokens: part.totalUsage.totalTokens,
      reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens,
      cachedInputTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens,
    },
  },
});
