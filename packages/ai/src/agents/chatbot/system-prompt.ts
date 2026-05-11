/**
 * Chatbot system prompt — the authoring surface is now the
 * `system-prompt.md` template in this folder, rendered on every turn
 * by `buildChatbotSystemPrompt` in `../shared/prompt-renderer.ts`.
 *
 * This file stays as a thin re-export so callers (agent runner, tests)
 * keep importing from the same path they did before the .md extraction.
 */
export { buildChatbotSystemPrompt } from "../shared/prompt-renderer";
