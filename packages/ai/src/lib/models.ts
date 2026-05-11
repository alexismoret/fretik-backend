/**
 * Centralised OpenRouter model identifiers for non-primary chat tasks.
 * The primary / fallback chat models for the chatbot itself live in
 * `openrouter.ts` — this file is for the "cheap, short extraction"
 * routing shared across RAG ingestion, multi-query reformulation,
 * and (future) message compaction summarisation.
 *
 * `CHEAP_MODEL` is the single point of edit for:
 *   - Phase 7b contextual enrichment (services/vectorize/contextual-enrichment.ts)
 *   - Phase 7c multi-query reformulation  (services/search/multi-query.ts)
 *   - Phase 8  compaction summariser      (services/compaction/summarizer.ts)
 *
 * Default: `openai/gpt-oss-20b` — Apache-2.0 MoE 21B (3.6B active),
 * $0.03 / $0.14 per MTok on OpenRouter. 3× cheaper than Gemini 2.5 Flash
 * Lite with better GPQA / HLE benchmarks. Stays on the existing OpenRouter
 * provider (no new SDK, no new API key). See
 * `chatbot-overhaul-progress.json.keyDecisions.phase7ContextualizationModel`.
 *
 * Override via `OPENROUTER_CHEAP_MODEL` env var — any OpenRouter model ID
 * works as long as it supports `generateText` (standard chat completion).
 */
export const CHEAP_MODEL =
  process.env.OPENROUTER_CHEAP_MODEL ?? "openai/gpt-oss-20b";
