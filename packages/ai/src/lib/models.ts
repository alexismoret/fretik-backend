import { getProfileForRole } from "./model-registry/resolve";

/**
 * OpenRouter model id for "cheap, short extraction" one-shots — the
 * registry's `cheap-tasks` role (default `openai/gpt-oss-20b`).
 * Shared by:
 *   - Phase 7b contextual enrichment (services/vectorize/contextual-enrichment.ts)
 *   - Phase 7c multi-query reformulation  (services/search/multi-query.ts)
 *   - catch-up summaries                  (services/catch-up-summary.ts)
 *   - conversation titles                 (services/conversation-title/generate.ts)
 *
 * Call sites pass their own per-call settings (`reasoning`, etc.) to
 * `openrouter.chat(CHEAP_MODEL, …)` — the registry only owns WHICH
 * model serves the role. Changing it is a reviewed edit to
 * `model-registry/profiles.ts`.
 */
export const CHEAP_MODEL = getProfileForRole("cheap-tasks").catalog.id;
