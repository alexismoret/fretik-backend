import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../../agents/shared/runtime-context";
import { askUserQuestionSchema } from "./schema";

/**
 * `askUserQuestion` (chat) — Fretik's equivalent of Claude Code's
 * `AskUserQuestion`.
 *
 * Core tool (always loaded). Lets the model present 1–4 multiple-choice
 * questions to the user when intent is ambiguous, when proposing a
 * memory write, or when offering meaningful direction choices. The
 * frontend renders the questions as a structured form; the model never
 * tries to guess once it has decided to ask.
 *
 * Non-blocking behaviour: `execute` returns immediately with the input
 * questions echoed back as the tool result (`answers` empty). The
 * frontend reads the input from the streamed `tool-askUserQuestion`
 * part, renders the form, and on submit posts a NEW user message with
 * the formatted answers — the model resumes from there with the answers
 * visible in the conversation history. This avoids a server-side wait
 * loop and keeps the SSE stream cleanly turn-based. (The workflow
 * executor uses a BLOCKING variant — `./workflow.ts` — that parks the run
 * on a `question` approval instead.)
 */
export const createAskUserQuestionTool = () =>
  tool({
    description: [
      "Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions, or offer choices about how to proceed.",
      "",
      "Use this tool when:",
      "1. The user's intent is ambiguous and you cannot resolve it from history / RAG / SQL within 1-2 steps (e.g. two entities match a name, two valid interpretations of a vague request).",
      "2. You are about to propose a memory write — present 'Save / Not now / Reword first' style options instead of asking in free text.",
      "3. You need a decision that materially changes the next steps (e.g. 'Generate as Excel or PDF?').",
      "",
      "Do NOT use this tool when:",
      "- The answer is trivial and you can pick a sensible default (then proceed and name the assumption in your response).",
      "- The question is yes/no without real downstream impact.",
      "- You haven't yet tried to resolve the ambiguity with one targeted tool call.",
      "",
      "Notes:",
      "- The UI always offers an 'Other' free-text option — do NOT include one in your `options` array.",
      "- Set `multiSelect: true` when answers are not mutually exclusive.",
      "- If you recommend a specific option, make it the first in the list and add ' (Recommended)' to its label.",
      "- Use the optional `preview` field on options when you need to show concrete artifacts to compare (code snippets, config examples). Markdown rendered. Single-select only.",
      "- Submit 1 to 4 questions per call. Question texts must be unique and option labels unique within each question.",
    ].join("\n"),
    inputSchema: z.object({
      questions: z
        .array(askUserQuestionSchema)
        .min(1)
        .max(4)
        .describe("Questions to ask the user (1 to 4 questions per call)."),
      metadata: z
        .object({
          source: z
            .string()
            .optional()
            .describe(
              "Optional identifier for the source of this question (e.g. 'memory-propose', 'entity-disambig'). Used for telemetry.",
            ),
        })
        .optional()
        .describe(
          "Optional metadata for tracking and analytics purposes. Not displayed to user.",
        ),
    }),
    execute: async ({ questions, metadata }, options) => {
      // Validate runtime context is wired correctly even though we don't
      // currently read teamId / userId here. Future telemetry will key
      // off this context; calling it now ensures the singleton DI path
      // is exercised on every invocation (catches silent regressions in
      // experimental_context plumbing). Discard the result intentionally.
      void getRuntimeContext(options);

      return {
        questions,
        // Empty until the user has answered. The frontend overlays the
        // collected answers in its own state and POSTs them as a fresh
        // user turn — this tool result itself is intentionally empty.
        answers: {} as Record<string, string>,
        annotations: {} as Record<string, { preview?: string; notes?: string }>,
        metadata,
      };
    },
  });
