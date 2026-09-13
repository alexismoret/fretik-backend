import { z } from "zod";

/**
 * The chat-suggestions contract: what the API returns, what a client may send
 * back, and — in the same file on purpose — what the MODEL is asked to
 * produce. The generator renders `suggestionOutputSchema` into its prompt and
 * validates the answer against it, so a field that drifts here drifts in both
 * places at once instead of one of them.
 *
 * Kept db-free (pure zod, like `schemas/pins.ts`): the `.openapi()` extension
 * is patched in by the API entrypoint, so this file imports nothing but `zod`.
 */

export const chatSuggestionKindSchema = z.enum([
  "pending",
  "follow_up",
  "periodic",
  "insight",
  "capability",
]);
export type ChatSuggestionKind = z.infer<typeof chatSuggestionKindSchema>;

/**
 * Descending priority. Used to pick which suggestions survive the cap, so a
 * batch never fills up with five follow-ups while an approval waits.
 */
export const CHAT_SUGGESTION_PRIORITY: readonly ChatSuggestionKind[] = [
  "pending",
  "follow_up",
  "periodic",
  "insight",
  "capability",
];

/** What one batch may offer, and how much of it one kind may take. */
export const MAX_CHAT_SUGGESTIONS = 6;
export const MAX_PER_KIND = 2;

// ---------------------------------------------------------------------------
// Wire — what the frontend reads
// ---------------------------------------------------------------------------

export const chatSuggestionSchema = z.object({
  id: z.uuid(),
  kind: chatSuggestionKindSchema,
  /** Card title: imperative, what the person gets. */
  label: z.string(),
  /** The message sent verbatim when the card is clicked. */
  prompt: z.string(),
  /** One line of "why now". */
  reason: z.string(),
});
export type ChatSuggestion = z.infer<typeof chatSuggestionSchema>;

export const chatSuggestionsResponseSchema = z.object({
  items: z.array(chatSuggestionSchema),
  /**
   * Nothing to personalise from — no episodes, no conversations, no memory.
   * The client renders its static starter cards instead, and the server has
   * spent no LLM call reaching that conclusion.
   */
  coldStart: z.boolean(),
  /** When the served batch was written; null when there is none. */
  generatedAt: z.date().nullable(),
});
export type ChatSuggestionsResponse = z.infer<
  typeof chatSuggestionsResponseSchema
>;

/**
 * A suggestion leaves `active` in one of two ways the user chooses. Both are
 * kept: what people send and what they reject is the only quality signal this
 * feature has, and the last two weeks of it are fed back to the generator.
 */
export const chatSuggestionFeedbackSchema = z.object({
  status: z.enum(["used", "dismissed"]),
});
export type ChatSuggestionFeedback = z.infer<
  typeof chatSuggestionFeedbackSchema
>;

// ---------------------------------------------------------------------------
// Model output — rendered into the prompt, validated on the way back
// ---------------------------------------------------------------------------

/**
 * Storage limits, which are also the display limits. The lengths the PROMPT
 * asks for are shorter (60 / 120) and deliberately not enforced here: a model
 * that writes a 130-character reason has not made a mistake worth losing a
 * card over, so the parser clips to these and keeps the suggestion. What the
 * schema still refuses is an empty string or prose where a label belongs.
 */
export const MAX_LABEL_CHARS = 80;
export const MAX_REASON_CHARS = 160;
export const MAX_PROMPT_CHARS = 600;

export const suggestionDraftSchema = z.object({
  kind: chatSuggestionKindSchema.describe(
    "pending = something waits on this person; follow_up = an open thread or an undecided question; periodic = a rhythm the dates make visible; insight = a pattern worth a look; capability = a workflow or page the team owns and is not using.",
  ),
  label: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Imperative, what the person gets, 60 characters or fewer. No trailing period.",
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .describe(
      "The request itself, complete enough to run in one turn, naming the real client, document, workflow or decision it is about.",
    ),
  reason: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "Why now, citing the fact from the context it rests on. 120 characters or fewer.",
    ),
  sourceIds: z
    .array(z.string())
    .default([])
    .describe(
      "The ids from the context this rests on, exactly as written there (e.g. episode:<uuid>).",
    ),
});
export type SuggestionDraft = z.infer<typeof suggestionDraftSchema>;

export const suggestionOutputSchema = z.object({
  suggestions: z.array(suggestionDraftSchema).max(8),
});
