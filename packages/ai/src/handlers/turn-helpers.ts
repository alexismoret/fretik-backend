import type { LanguageModelUsage, UIMessage } from "ai";
import type { TurnUsage } from "../lib/turn-usage";

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
  /**
   * What the whole turn spent, delegates included.
   *
   * `usage` below is the PARENT stream's own tokens, which on a turn that
   * delegated a page build is a small fraction of the bill — the builder's
   * thirty-odd steps run inside one tool call and appear nowhere in it. This
   * field is the turn's real price, counted by the process that paid it
   * (`lib/turn-usage.ts`), and it is what the evals read instead of summing
   * someone else's observations.
   */
  spend?: TurnUsage,
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
    ...(spend === undefined ? {} : { spend }),
  },
});

/**
 * How long each tool call of a turn took — the time a step row prints beside
 * its caption in the transcript.
 *
 * Wall-clock, from the moment the model starts writing the call
 * (`tool-input-start`) to the moment its result, error or refusal comes back:
 * exactly the span the transcript draws the step as running. A call that
 * arrives whole (`tool-call` with no input stream before it) starts its clock
 * there instead. A PRELIMINARY result is progress, not the end, and stops
 * nothing.
 *
 * Fed from a `toUIMessageStream` `messageMetadata` callback, which the SDK calls
 * for every stream part: each settled call returns
 * `{ stepDurations: { [toolCallId]: ms } }`, sent as its own
 * `message-metadata` chunk. The client deep-merges message metadata, so the
 * map accumulates call by call — live in the transcript, and persisted with
 * the message like the rest of its metadata, so a reload keeps the times.
 *
 * One clock per model stream: a fallback or a continuation stream starts its
 * own, and their maps merge into the same message all the same.
 */
export const createStepClock = (
  now: () => number = Date.now,
): ((part: StepClockPart) => Record<string, unknown> | undefined) => {
  const startedAt = new Map<string, number>();

  const start = (toolCallId: string | undefined): undefined => {
    if (toolCallId !== undefined && !startedAt.has(toolCallId)) {
      startedAt.set(toolCallId, now());
    }
    return undefined;
  };

  const settle = (
    toolCallId: string | undefined,
  ): Record<string, unknown> | undefined => {
    const begun =
      toolCallId === undefined ? undefined : startedAt.get(toolCallId);
    if (toolCallId === undefined || begun === undefined) return undefined;
    startedAt.delete(toolCallId);
    return { stepDurations: { [toolCallId]: Math.max(0, now() - begun) } };
  };

  return (part) => {
    switch (part.type) {
      case "tool-input-start":
        return start(part.id);
      case "tool-call":
        return start(part.toolCallId);
      case "tool-result":
        return part.preliminary === true ? undefined : settle(part.toolCallId);
      case "tool-error":
      case "tool-output-denied":
        return settle(part.toolCallId);
      default:
        return undefined;
    }
  };
};

/**
 * The fields of a stream part the step clock reads. Every `TextStreamPart`
 * fits it, so the clock takes the SDK's parts as they come — and a test can
 * hand it the three fields that matter instead of a full SDK part.
 */
interface StepClockPart {
  type: string;
  id?: string;
  toolCallId?: string;
  preliminary?: boolean;
}
