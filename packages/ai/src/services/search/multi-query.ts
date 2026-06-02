import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { instrumentModel } from "../../lib/model-instrumentation";
import { CHEAP_MODEL } from "../../lib/models";
import { openrouter } from "../../lib/openrouter";
import { withSlot } from "../../lib/rate-limit";

/**
 * Multi-query reformulation for hybrid RAG search.
 *
 * Generates 2 additional rephrasings of the user's query through the
 * cheap model (`openai/gpt-oss-20b` via OpenRouter — same `CHEAP_MODEL`
 * constant used by Phase 7b contextual enrichment and Phase 8 compaction)
 * and returns `[original, variant1, variant2]`. The original query is
 * ALWAYS kept as variant #1 so a single weak reformulation can never
 * wipe the intent.
 *
 * Why: the Anthropic Contextual Retrieval cookbook recommends running
 * several diverse queries through the hybrid retriever and merging the
 * results via RRF. Vocabulary diversity recovers recall on content that
 * uses synonyms, trade names, or acronyms the original query didn't.
 *
 * Concurrency: routed through the same Redis distributed semaphore as
 * enrichment (`openrouter:cheap`) so a burst of concurrent chatbot
 * turns can't blow OpenRouter's account-wide limit for the cheap model.
 *
 * Failure policy: the whole step is soft — if the LLM rejects, times
 * out, or returns garbage, we fall back to `[originalQuery]` and the
 * caller still gets a working hybrid search (just no recall bump from
 * reformulation). Never throws.
 */

const MULTI_QUERY_TEMPERATURE = 0.3;
const MULTI_QUERY_MAX_TOKENS = 300;
const TARGET_VARIANT_COUNT = 2;

const CHEAP_MODEL_MAX_CONCURRENT = Number(
  process.env.AI_CHEAP_MODEL_MAX_CONCURRENT ?? "20",
);

const CHEAP_MODEL_HOLD_TIMEOUT_MS = 30_000;

/**
 * Hard wall-clock cap on a single `generateText` call. The `withSlot`
 * hold timeout is the per-slot reclaim timer (what Redis considers a
 * "stuck" replica) — NOT a per-request execution cap. Without this
 * AbortSignal, a slow OpenRouter response could block the slot plus
 * burn the agent's step budget for the full 30s hold window.
 *
 * Bumped from 8s → 10s after observing occasional `effort: "low"`
 * timeouts on `gpt-oss-20b`: even with reasoning capped to "low",
 * the model can spend 5-9s on the reformulation when an OpenRouter
 * route is congested. 10s covers the long tail without dominating
 * the RAG turn (still parallelisable with embeddings + hybrid
 * search inside `searchRAG`).
 */
const MULTI_QUERY_TIMEOUT_MS = 10_000;

/**
 * Multi-query reformulation is a pure formatting task — produce 2
 * alternate phrasings of one input — with zero multi-step
 * decision-making. On reasoning-capable models (default for
 * `openai/gpt-oss-20b` on OpenRouter), the provider applies a
 * non-trivial reasoning budget out of the box; `maxOutputTokens`
 * only caps the visible text and does NOT bound
 * `outputTokenDetails.reasoningTokens`. Result observed in practice:
 * a reformulation call generated 17 773 tokens and missed the 8 s
 * timeout, falling back to `[original]` — wasted spend, wasted
 * latency, zero quality gain.
 *
 * First attempt was `reasoning: { enabled: false, effort: "none" }`
 * — some upstream OpenRouter routes for `gpt-oss-20b` rejected with
 * `Reasoning is mandatory for this endpoint and cannot be disabled.`
 * (which providers exactly is not exposed by OpenRouter's response
 * envelope). Switched to `effort: "low"` so the request is
 * accepted by every route while keeping the reasoning budget tight
 * — no runaway, no rejection.
 */
const cheapModel = instrumentModel(
  openrouter.chat(CHEAP_MODEL, {
    reasoning: { effort: "low" },
  }),
);

/**
 * Static rubric — identical across every call, so it lives in the
 * system prompt. The variable payload (the user query) is sent as the
 * user prompt below. Providers that auto-cache identical systems get a
 * small free win; mainly it gives the model a clearer separation
 * between rules and data and removes the "User query:\n${query}" tail
 * that was easy to mis-parse on noisy completions.
 */
const SYSTEM_PROMPT = `You are a search query rewriter for a multilingual B2B business knowledge base (contracts, invoices, proposals, reports, internal memos, and other office documents).

Rewrite the user's query as ${TARGET_VARIANT_COUNT} ALTERNATE phrasings that preserve the exact intent but use different vocabulary, synonyms, or trade terms. The goal is to improve recall in a hybrid vector + BM25 retriever.

Rules:
- Return EXACTLY ${TARGET_VARIANT_COUNT} alternate phrasings, one per line.
- Do NOT number them, do NOT add quotes, do NOT add explanations.
- Keep the original language of the query (do not translate).
- Keep proper nouns, codes, IDs, and numbers verbatim when present.
- Each phrasing must be a complete, standalone search query.`;

const parseVariants = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Strip common LLM decorations (numbered lists, bullet markers, quotes).
    .map((line) => line.replace(/^[-*•]\s+|^\d+[.)]\s+/u, "").trim())
    .map((line) => line.replace(/^["'`](.*)["'`]$/u, "$1").trim())
    .filter((line) => line.length > 0);

/**
 * Returns `[originalQuery, ...variants]`, where `variants.length` is at
 * most `TARGET_VARIANT_COUNT`. The original is always first and always
 * present — even if reformulation fails entirely.
 */
export const generateQueryVariants = async (
  originalQuery: string,
): Promise<string[]> => {
  const trimmed = originalQuery.trim();
  if (trimmed.length === 0) return [];

  let rawText: string;
  try {
    const { text } = await withSlot(
      "openrouter:cheap",
      CHEAP_MODEL_MAX_CONCURRENT,
      CHEAP_MODEL_HOLD_TIMEOUT_MS,
      () =>
        generateText({
          model: cheapModel,
          system: SYSTEM_PROMPT,
          prompt: trimmed,
          temperature: MULTI_QUERY_TEMPERATURE,
          maxOutputTokens: MULTI_QUERY_MAX_TOKENS,
          abortSignal: AbortSignal.timeout(MULTI_QUERY_TIMEOUT_MS),
          // Nests under the `searchKnowledge` tool call → `chatbot-turn`.
          experimental_telemetry: telemetryFor("rag-multi-query"),
        }),
    );
    rawText = text;
  } catch (err) {
    console.warn(
      "[multi-query] reformulation failed, falling back to original:",
      err instanceof Error ? err.message : err,
    );
    return [trimmed];
  }

  const parsed = parseVariants(rawText);
  const unique: string[] = [];
  const seen = new Set<string>();
  seen.add(trimmed.toLowerCase());
  for (const variant of parsed) {
    const key = variant.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(variant);
    if (unique.length >= TARGET_VARIANT_COUNT) break;
  }

  return [trimmed, ...unique];
};
