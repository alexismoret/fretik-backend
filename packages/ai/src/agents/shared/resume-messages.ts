import type { ModelMessage } from "ai";

/**
 * Turn what a cut run said into a briefing the NEXT attempt can build on.
 *
 * A dispatch that dies mid-flight is retried today from the original message
 * list, so the second model starts blind. Measured in production 2026-09-14: a
 * page build had probed its four data sources and read the component APIs it
 * needed — four useful steps — when the host cut the stream after 133 seconds.
 * The fallback restarted from zero, re-probed nothing, invented four provider
 * keys that do not exist and wrote a `page.json` the runtime refused. Ninety
 * steps and $1.72 for a page that never loaded.
 *
 * What is safe to carry, and what is not:
 *
 * - REASONING IS DROPPED. Thinking blocks carry provider-scoped signatures
 *   (Anthropic and Google both verify them) and the retry may be a different
 *   family, on a different host. The same rule `prepareModelMessages` applies
 *   across turns, for the same reason.
 * - `providerOptions` GO WITH IT, at message and part level: they are the
 *   envelope the FIRST provider was spoken to in.
 * - A TOOL CALL WITH NO ANSWER IS DROPPED. The SDK's own repair for a turn cut
 *   between a call and its result (`ignoreIncompleteToolCalls`): sending one
 *   makes the next provider throw `MissingToolResultsError`, which would wedge
 *   the retry before its first token.
 *
 * Nothing survives that is not an assistant message the model completed or a
 * tool result it received, so the worst case is the empty list — which is
 * exactly the behaviour this replaced.
 */

type Part = { type: string; toolCallId?: string; providerOptions?: unknown };

const isPartArray = (content: unknown): content is Part[] =>
  Array.isArray(content) &&
  content.every(
    (part) => part !== null && typeof part === "object" && "type" in part,
  );

/** Strip the provider envelope from a part, and drop reasoning outright. */
const carryParts = (parts: readonly Part[]): Part[] =>
  parts
    .filter((part) => part.type !== "reasoning")
    .map(({ providerOptions: _dropped, ...part }) => part);

const toolCallIds = (message: ModelMessage): string[] => {
  if (message.role !== "assistant" || !isPartArray(message.content)) return [];
  return message.content
    .filter((part) => part.type === "tool-call")
    .map((part) => part.toolCallId ?? "");
};

const answeredIds = (messages: readonly ModelMessage[]): Set<string> => {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const parts: readonly Part[] = isPartArray(message.content)
      ? message.content
      : [];
    for (const part of parts) {
      if (part.toolCallId !== undefined) answered.add(part.toolCallId);
    }
  }
  return answered;
};

/**
 * The response messages of a finished run, reduced to what a second attempt
 * may safely be given. Empty when nothing survives.
 */
export const continuableResponseMessages = (
  response: readonly ModelMessage[] | undefined,
): ModelMessage[] => {
  if (response === undefined || response.length === 0) return [];
  const answered = answeredIds(response);
  const carried: ModelMessage[] = [];
  for (const message of response) {
    if (!isPartArray(message.content)) {
      carried.push(message);
      continue;
    }
    if (toolCallIds(message).some((id) => !answered.has(id))) continue;
    const parts = carryParts(message.content);
    if (parts.length === 0) continue;
    const { providerOptions: _dropped, ...rest } = message;
    carried.push({ ...rest, content: parts } as ModelMessage);
  }
  return carried;
};
