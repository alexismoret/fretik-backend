import { z } from "zod";

/**
 * Shared `askUserQuestion` question shape — used by BOTH the chat tool
 * (`./chat.ts`, non-blocking) and the workflow tool (`./workflow.ts`, which
 * parks the run on a `question` approval). One schema so the two stay in
 * lockstep and the model applies the same patterns it learned in training.
 */

export const askUserQuestionOptionSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      "The display text for this option (1-5 words). Should be concise and clearly describe the choice. If you recommend a specific option, add ' (Recommended)' to its label.",
    ),
  description: z
    .string()
    .min(1)
    .describe(
      "Explanation of what this option means or what will happen if chosen. Useful for trade-offs or implications.",
    ),
  preview: z
    .string()
    .optional()
    .describe(
      "Optional markdown preview content rendered when this option is focused. Use for code snippets, configuration examples, or visual comparisons that help users compare options. Only supported for single-select questions.",
    ),
});

export const askUserQuestionSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      "The complete question to ask the user. Should be clear, specific, and end with a question mark. Phrase appropriately for multiSelect when relevant ('Which features do you want to enable?').",
    ),
  header: z
    .string()
    .min(1)
    .describe(
      "A tiny chip label — ONE short noun, not a phrase (e.g. 'Source', 'Method', 'Format', 'Save?'). Aim for ≤12 characters.",
    ),
  options: z
    .array(askUserQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe(
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). Do NOT include an 'Other' option — the UI provides one automatically for free-text input.",
    ),
  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    ),
});
