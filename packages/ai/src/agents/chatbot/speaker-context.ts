import type { UIMessage } from "ai";

type Participant = { userId: string; name: string };

/**
 * Read the human author id a `user` message carries under `metadata.authorId`
 * (stamped by `saveMessage` / surfaced by `loadConversationForAgent`).
 */
const authorIdOf = (message: UIMessage): string | undefined => {
  const { metadata } = message;
  if (metadata && typeof metadata === "object" && "authorId" in metadata) {
    const value = Reflect.get(metadata, "authorId");
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

/** Prefix the first text part of a message — leaves files/tools untouched. */
const prefixFirstText = (
  parts: UIMessage["parts"],
  prefix: string,
): UIMessage["parts"] => {
  let done = false;
  return parts.map((part) => {
    if (!done && part.type === "text") {
      done = true;
      return { ...part, text: `${prefix}${part.text}` };
    }
    return part;
  });
};

/**
 * Attribute speakers in a collaborative conversation, conditionally.
 *
 * Solo conversations (one participant) are left **byte-identical** to the
 * single-user behaviour — no labels, no participants block — so the common
 * case can't regress. As soon as a second person joins, every `user` message
 * (including those sent before they joined — `authorId` is stored from the
 * first message) is prefixed `[Name]: ` and a roster is returned for the
 * system prompt. Research shows inline labels don't measurably hurt accuracy
 * and are the only portable mechanism (the model is reached via OpenRouter,
 * which has no per-message author field).
 */
export const buildSpeakerContext = (params: {
  history: UIMessage[];
  participants: Participant[];
}): { history: UIMessage[]; participantsBlock?: string } => {
  const { history, participants } = params;

  if (participants.length < 2) return { history };

  const nameById = new Map(participants.map((p) => [p.userId, p.name]));

  const history2 = history.map((message) => {
    if (message.role !== "user") return message;
    const name = nameById.get(authorIdOf(message) ?? "");
    if (!name) return message;
    return { ...message, parts: prefixFirstText(message.parts, `[${name}]: `) };
  });

  const participantsBlock = participants.map((p) => `- ${p.name}`).join("\n");

  return { history: history2, participantsBlock };
};
