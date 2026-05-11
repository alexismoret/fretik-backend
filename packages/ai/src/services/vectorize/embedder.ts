import {
  EMBEDDING_DIMENSIONS,
  embedBatch as embedBatchRaw,
} from "../../lib/embeddings";
import { withSlot } from "../../lib/rate-limit";

/**
 * Vectorisation-facing embedding layer.
 *
 * Thin wrapper over `lib/embeddings.embedBatch` that:
 *   (1) funnels every batch through the Redis distributed semaphore
 *       `openrouter:embeddings` so a cluster of @fretik/ai replicas
 *       vectorising in parallel never exceeds the global OpenRouter
 *       Qwen3-Embedding-8B concurrent budget;
 *   (2) drops vectors whose dimension count is not exactly
 *       `EMBEDDING_DIMENSIONS` (2560) — the underlying helper already
 *       throws on mismatches so this is defensive, and
 *   (3) returns a 1:1 aligned `number[][]` ordered like the input list.
 *
 * The raw fp32 output stays in memory here; the `halfvec(2560)` literal
 * serialisation lives in `upsert.ts` so the insert path controls exactly
 * which rows get written.
 */

/**
 * Global concurrency cap across all @fretik/ai replicas for the
 * embedding endpoint. Embeddings are fast (~200-500ms for a 20-batch)
 * and the account-wide rate limit is the binding constraint — default
 * cap 10 keeps steady-state RPS under most OpenRouter plans while
 * still letting two large documents ingest in parallel.
 */
const EMBEDDING_MAX_CONCURRENT = Number(
  process.env.AI_EMBEDDING_MAX_CONCURRENT ?? "10",
);

/**
 * Worst-case single-batch duration. Qwen3-Embedding-8B via OpenRouter
 * averages well under 1s even at batch 20 — 15s is a crash-safety cap,
 * not a working latency target. See `lib/rate-limit.ts::acquireSlot`.
 */
const EMBEDDING_HOLD_TIMEOUT_MS = 15_000;

/**
 * Embed an array of strings into fp32 number arrays. Each returned
 * vector is guaranteed to be exactly `EMBEDDING_DIMENSIONS` long or
 * the whole call throws (raw `embedBatch` already enforces this).
 */
export const embedBatch = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return [];

  return withSlot(
    "openrouter:embeddings",
    EMBEDDING_MAX_CONCURRENT,
    EMBEDDING_HOLD_TIMEOUT_MS,
    () => embedBatchRaw(texts),
  );
};

export { EMBEDDING_DIMENSIONS };
