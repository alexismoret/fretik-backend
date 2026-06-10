import { type UIMessage, streamText } from "ai";
import { telemetryFor } from "../lib/langfuse";
import { instrumentModel } from "../lib/model-instrumentation";
import { CHEAP_MODEL } from "../lib/models";
import { openrouter } from "../lib/openrouter";

type Participant = { userId: string; name: string };

const PART_TOOL_PREFIX = "tool-";

/**
 * Cap on the number of missed messages fed to the summariser — a latency
 * guard so a long absence doesn't produce a huge prompt. gpt-oss-20b's window
 * (131K) is far above this; the cap is purely about keeping the call fast.
 */
const MAX_MISSED_MESSAGES = 60;

/**
 * Catch-up runs on the shared `CHEAP_MODEL` (gpt-oss-20b) with low reasoning
 * effort — the summary is short and the input small, so the cheapest/fastest
 * tier keeps the banner snappy (the previous pre-extract model could take
 * ~10s). Same model family as RAG enrichment / multi-query.
 */
const summaryModel = instrumentModel(
  openrouter.chat(CHEAP_MODEL, { reasoning: { effort: "low" } }),
);

/** Read the human author id stamped under a user message's metadata. */
const authorIdOf = (message: UIMessage): string | undefined => {
  const { metadata } = message;
  if (metadata && typeof metadata === "object" && "authorId" in metadata) {
    const value = Reflect.get(metadata, "authorId");
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

/** Flatten a message's text parts; tool parts collapse to a short marker. */
const extractText = (message: UIMessage): string => {
  const fragments: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      fragments.push(part.text);
    } else if (part.type.startsWith(PART_TOOL_PREFIX)) {
      fragments.push(`[${part.type.slice(PART_TOOL_PREFIX.length)}]`);
    }
  }
  return fragments.join("\n").trim();
};

/**
 * Render the missed messages as a speaker-attributed transcript. User turns
 * are labelled with their author's name (falling back to "A teammate"),
 * assistant turns as "Assistant".
 */
const buildTranscript = (
  messages: UIMessage[],
  participants: Participant[],
): string => {
  const nameById = new Map(participants.map((p) => [p.userId, p.name]));
  return messages
    .map((message) => {
      const body = extractText(message);
      if (body.length === 0) return "";
      const speaker =
        message.role === "assistant"
          ? "Assistant"
          : (nameById.get(authorIdOf(message) ?? "") ?? "A teammate");
      return `${speaker}: ${body}`;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
};

const SUMMARY_PROMPT = `A teammate just opened a shared work conversation they'd missed. In your own words, give them the gist in **2-3 short sentences (≈50 words max)** — only what matters and anything that concerns them. Natural prose, no headings or lists, no preamble. Refer to people by name. Cover only the new messages; use the earlier context just to understand them. If nothing meaningful happened, say so in a single sentence.

CRITICAL: Write your entire summary in the SAME LANGUAGE as the conversation messages below. Never translate to another language.`;

/**
 * Summarise the messages a member missed since they last read the
 * conversation. `priorContext` is a short window of already-read messages
 * passed only to ground the summary — the model is told to summarise the
 * unread tail alone. Returns a short, speaker-aware catch-up, or a friendly
 * note when there's nothing to summarise. Reuses the lighter `preextractModel`
 * (same tier as the pre-extract / compaction summariser) — a short
 * summarisation doesn't need the main chat model. Soft-fails to a generic
 * line on error so the endpoint never 500s on a flaky model call.
 */
export const summariseMissedMessages = async (params: {
  missed: UIMessage[];
  priorContext: UIMessage[];
  participants: Participant[];
}): Promise<string> => {
  const { missed, priorContext, participants } = params;

  // Keep only the most recent missed messages — a latency guard.
  const missedTranscript = buildTranscript(
    missed.slice(-MAX_MISSED_MESSAGES),
    participants,
  );
  if (missedTranscript.length === 0) {
    return "You're all caught up — nothing new since you last read this conversation.";
  }

  const priorTranscript = buildTranscript(priorContext, participants);
  const groundedPrompt = [
    SUMMARY_PROMPT,
    priorTranscript.length > 0
      ? `\nEarlier context (already seen — for grounding only):\n${priorTranscript}`
      : "",
    `\nNew messages to summarise:\n${missedTranscript}`,
  ].join("\n");

  try {
    const result = streamText({
      model: summaryModel,
      prompt: groundedPrompt,
      temperature: 0.3,
      maxOutputTokens: 500,
      abortSignal: AbortSignal.timeout(30_000),
      experimental_telemetry: telemetryFor("catch-up-summary"),
    });
    const text = (await result.text).trim();
    return text.length > 0
      ? text
      : "You're all caught up — nothing new since you last read this conversation.";
  } catch (error) {
    console.warn(
      "[catch-up-summary] failed:",
      error instanceof Error ? error.message : error,
    );
    return "Couldn't generate a summary right now. Open the conversation to read the latest messages.";
  }
};
