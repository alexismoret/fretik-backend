import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { instrumentModel } from "../../lib/model-instrumentation";
import { CHEAP_MODEL } from "../../lib/models";
import { openrouter } from "../../lib/openrouter";
import { withSlot } from "../../lib/rate-limit";
import type { Chunk } from "./chunker";

/**
 * Anthropic Contextual Retrieval per-chunk enrichment.
 *
 * Adds a 50-100 token "situating" preface to every chunk so that the
 * downstream embedding and BM25 stages see a self-contained fragment
 * instead of an orphaned slice. Model: `openai/gpt-oss-20b` via
 * OpenRouter (`CHEAP_MODEL` — $0.03 / $0.14 per MTok, cheapest reasoning
 * model on the stack).
 *
 * The rubric is in `ENRICHMENT_SYSTEM_PROMPT` (the Anthropic cookbook
 * verbatim, just split out so the variable payload — document context +
 * chunk — is sent as the user prompt). System/user separation gives
 * caching-aware providers a free win and makes the model treat the
 * instructions with more weight.
 *
 * Concurrency: every call goes through the Redis distributed semaphore
 * `openrouter:cheap` so a cluster of @fretik/ai replicas vectorising in
 * parallel never exceeds the configured global limit. See
 * `lib/rate-limit.ts` for the slot acquisition mechanics.
 */

const ENRICHMENT_TEMPERATURE = 0;
const ENRICHMENT_MAX_TOKENS = 300;

/**
 * Static instructions for the enrichment model. Moved out of the per-call
 * `prompt` so the variable payload (document context + chunk) is cleanly
 * separated from the constant rubric. Providers that cache identical
 * system messages get a small free win; more importantly it gives the
 * model a clearer separation between rubric and data.
 */
const ENRICHMENT_SYSTEM_PROMPT =
  `You situate a chunk within the document it was extracted from so the chunk becomes self-contained for retrieval.\n\n` +
  `Given a document and a chunk extracted from it, write a short succinct context (1–2 sentences) that situates the chunk within the overall document for the purposes of improving search retrieval of the chunk.\n\n` +
  `Answer only with the succinct context and nothing else.`;

/**
 * Doc-context budget sent to the enrichment model per chunk. Anthropic's
 * Contextual Retrieval cookbook assumes ~8K-token documents (≈ 30K chars);
 * on 100-page PDFs we'd otherwise dispatch 200K+ chars × 20 concurrent
 * calls → runaway latency/cost + "lost-in-the-middle" degradation on
 * long-context LLMs.
 *
 * Strategy (see `buildDocContext`):
 *   - Documents ≤ `FULL_DOC_THRESHOLD_CHARS` → sent verbatim (the common
 *     case for invoices, single-page BLs, short contracts).
 *   - Longer documents → a synthetic "intro + local window" context: the
 *     first `DOC_INTRO_CHARS` chars (title, headings, first section) PLUS
 *     a symmetric window of `DOC_LOCAL_WINDOW_CHARS` chars centred on
 *     the target chunk's position in the source. Dedup'd when the two
 *     ranges overlap on short-ish docs.
 *
 * This preserves Anthropic's signal (the model sees doc-level context to
 * situate the chunk) while avoiding the quadratic cost + lost-in-middle
 * failure mode on long docs.
 */
const FULL_DOC_THRESHOLD_CHARS = 10_000;
const DOC_INTRO_CHARS = 4_000;
const DOC_LOCAL_WINDOW_CHARS = 4_000;

/**
 * Global concurrency cap across all @fretik/ai replicas for the cheap
 * chat model (contextual enrichment + Phase 7c multi-query + Phase 8
 * compaction summariser will all share this slot pool). Default is a
 * conservative 20 — matches ~20 RPS at ~1s latency, well under
 * `gpt-oss-20b` free-tier OpenRouter limits. Override via env for
 * load-testing or higher-tier accounts.
 */
const CHEAP_MODEL_MAX_CONCURRENT = Number(
  process.env.AI_CHEAP_MODEL_MAX_CONCURRENT ?? "20",
);

/**
 * Worst-case single-call duration. If a replica crashes mid-request its
 * slot is reclaimed after this many ms by the ZSET cleanup in
 * `acquireSlot`. Should be > any reasonable LLM latency for short
 * outputs (200 tokens × ~30 tok/s worst case ≈ 7s, we take 2× headroom).
 */
const CHEAP_MODEL_HOLD_TIMEOUT_MS = 30_000;

/**
 * In-process worker pool size — how many enrichment jobs this single
 * replica hands to the Redis limiter at once. The Redis semaphore is
 * the global cap; this is a local throttle so a single huge document
 * doesn't queue 1000 slots in Redis at once. Default 5 matches the
 * Phase 7 plan.
 */
const LOCAL_WORKER_COUNT = 5;

export interface EnrichedChunk {
  index: number;
  totalChunks: number;
  content: string;
  contextualPrefix: string;
}

/**
 * `gpt-oss-20b` on OpenRouter applies a non-trivial reasoning budget by
 * default. `maxOutputTokens` only caps the visible text and does NOT
 * bound `outputTokenDetails.reasoningTokens` — so a call that maxes its
 * budget on hidden reasoning returns an empty `text`. We cap reasoning
 * to "low" (same trick as multi-query.ts) so the visible output gets
 * room to materialise.
 *
 * Some upstream routes reject `effort: "none"` with
 * `Reasoning is mandatory for this endpoint and cannot be disabled.`,
 * so "low" is the floor that every route accepts.
 */
const cheapModel = instrumentModel(
  openrouter.chat(CHEAP_MODEL, {
    reasoning: { effort: "low" },
  }),
);

/**
 * Builds the bounded `{doc_content}` context passed to the enrichment
 * model for a given chunk. See the constants above for the rationale.
 *
 * For long documents, the chunk's approximate offset is estimated via
 * `chunk.index / chunk.totalChunks` — the chunker doesn't expose the
 * exact char offset and a proportional estimate is accurate enough for
 * a "situate me" context window (the model only needs nearby content,
 * not the exact neighbouring sentences).
 */
const buildDocContext = (docContent: string, chunk: Chunk): string => {
  if (docContent.length <= FULL_DOC_THRESHOLD_CHARS) {
    return docContent;
  }

  const intro = docContent.slice(0, DOC_INTRO_CHARS);

  const totalChunks = Math.max(chunk.totalChunks, 1);
  const ratio = totalChunks > 0 ? chunk.index / totalChunks : 0;
  const approxOffset = Math.floor(docContent.length * ratio);
  const halfWindow = Math.floor(DOC_LOCAL_WINDOW_CHARS / 2);
  const windowStart = Math.max(DOC_INTRO_CHARS, approxOffset - halfWindow);
  const windowEnd = Math.min(
    docContent.length,
    windowStart + DOC_LOCAL_WINDOW_CHARS,
  );
  const windowText = docContent.slice(windowStart, windowEnd);

  if (windowText.length === 0) {
    return intro;
  }

  // Tag the window so the model knows what it's looking at, and include
  // the char range for diagnostic value (no semantic impact).
  return `${intro}\n\n[… document truncated …]\n\n<local_window offset="${windowStart}">\n${windowText}\n</local_window>`;
};

const buildPrompt = (docContent: string, chunk: Chunk): string =>
  `<document>${buildDocContext(docContent, chunk)}</document>\n\n` +
  `<chunk>${chunk.content}</chunk>`;

const enrichOne = async (
  docContent: string,
  chunk: Chunk,
): Promise<EnrichedChunk> => {
  try {
    const { text } = await withSlot(
      "openrouter:cheap",
      CHEAP_MODEL_MAX_CONCURRENT,
      CHEAP_MODEL_HOLD_TIMEOUT_MS,
      () =>
        generateText({
          model: cheapModel,
          system: ENRICHMENT_SYSTEM_PROMPT,
          prompt: buildPrompt(docContent, chunk),
          temperature: ENRICHMENT_TEMPERATURE,
          maxOutputTokens: ENRICHMENT_MAX_TOKENS,
          experimental_telemetry: telemetryFor("vectorize-enrichment"),
        }),
    );
    return {
      index: chunk.index,
      totalChunks: chunk.totalChunks,
      content: chunk.content,
      contextualPrefix: text.trim(),
    };
  } catch (err) {
    // Contextual enrichment is a soft enhancement — if the cheap model
    // rejects or times out on a single chunk we keep the chunk with an
    // empty prefix rather than failing the whole ingestion run. The
    // `search_vector` generated column accepts empty prefixes via its
    // `coalesce("contextual_prefix",'')` expression.
    console.warn(
      `[contextual-enrichment] chunk ${chunk.index}/${chunk.totalChunks} enrichment failed:`,
      err instanceof Error ? err.message : err,
    );
    return {
      index: chunk.index,
      totalChunks: chunk.totalChunks,
      content: chunk.content,
      contextualPrefix: "",
    };
  }
};

/**
 * Runs enrichment calls through a small in-process worker pool whose
 * individual requests are further gated by the Redis semaphore. Results
 * are reassembled in input order.
 */
export const enrichChunks = async (
  docContent: string,
  chunks: Chunk[],
): Promise<EnrichedChunk[]> => {
  if (chunks.length === 0) return [];

  const results: EnrichedChunk[] = new Array(chunks.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(LOCAL_WORKER_COUNT, chunks.length) },
    async () => {
      while (cursor < chunks.length) {
        const i = cursor++;
        results[i] = await enrichOne(docContent, chunks[i]!);
      }
    },
  );

  await Promise.all(workers);
  return results;
};
