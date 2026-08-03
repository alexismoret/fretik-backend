/**
 * Single source of truth for the OpenRouter REST base URL.
 *
 * Every direct `fetch` against OpenRouter (chat completions, model catalog,
 * per-model endpoints, rerank) and every SDK client that takes an explicit
 * `baseURL` builds on this. `@openrouter/ai-sdk-provider` supplies its own
 * default, so only call sites that pass `baseURL` explicitly need it.
 *
 * Kept in `shared` because both `@fretik/shared` (memory path suggestion) and
 * `@fretik/ai` (model registry, metrics, rerank, scripts) call the API
 * directly.
 */
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
