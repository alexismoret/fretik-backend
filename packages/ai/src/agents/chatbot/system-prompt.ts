/**
 * Chatbot system prompt — the authoring surface is the UNIFIED
 * `../shared/agent-system-prompt.md` template (chatbot + workflow variants
 * via `<!-- AGENT:… -->` blocks), rendered on every turn by
 * `buildChatbotSystemPrompt` in `../shared/prompt-renderer.ts`.
 *
 * This file stays as a thin re-export so callers (agent runner, tests)
 * keep importing from the same path they did before the .md extraction.
 */
export { buildChatbotSystemPrompt } from "../shared/prompt-renderer";
