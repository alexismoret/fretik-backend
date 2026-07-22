import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { embed, embedMany } from "ai";
import { telemetryFor } from "./langfuse";
import { instrumentEmbeddingModel } from "./model-instrumentation";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw "Missing OPENROUTER_API_KEY env";
}

const embeddingModelId = process.env.OPENROUTER_EMBEDDING_MODEL;
if (!embeddingModelId) {
  throw "Missing OPENROUTER_EMBEDDING_MODEL env";
}

/**
 * Embedding dimension — matches `ai_vectors.embedding halfvec(2560)`.
 * Qwen3-Embedding-8B is truncated to 2560 via Matryoshka Representation
 * Learning by passing `dimensions: 2560` in the OpenRouter payload (native
 * parameter — no client-side truncation). 2560 ≈ the native dim of
 * Qwen3-Embedding-4B, NDCG@10 loss vs 4096 is ~1 point.
 *
 * pgvector HNSW caps the plain `vector` type at 2000 dims but supports
 * `halfvec` up to 4000 dims — that's why we landed on halfvec(2560) in
 * Phase 7a.
 */
export const EMBEDDING_DIMENSIONS = 2560;

/**
 * Intra-call embedding concurrency — how many 20-input batches `embedMany`
 * fires in parallel for ONE `embedBatch`. Default 2 (≈2× the single-document
 * indexing speed vs sequential). Cross-document concurrency stays bounded by
 * the `openrouter:embeddings` Redis semaphore in `services/vectorize/embedder.ts`
 * (so peak global ≈ that cap × this); env-overridable.
 */
const EMBEDDING_PARALLEL_CALLS = (() => {
  const raw = Number(process.env.AI_EMBEDDING_PARALLEL_CALLS);
  return Number.isInteger(raw) && raw > 0 ? raw : 2;
})();

/**
 * Dedicated OpenRouter provider for embeddings. `@openrouter/ai-sdk-provider`
 * v2.9.0 exposes no `dimensions` setting on `textEmbeddingModel`, but its
 * `doEmbed` spreads `config.extraBody` at the top level of the request body —
 * so the provider-level `extraBody` is how we send the Matryoshka `dimensions`
 * (load-bearing: the `halfvec(2560)` column depends on it) plus usage
 * accounting (`usage: { include: true }`) so OpenRouter returns the real USD
 * cost for the Langfuse `embedding` observation. A separate instance keeps
 * `dimensions` off the chat provider.
 *
 * Provider routing (2026-07-21): without preferences OpenRouter price-sorts,
 * and the pinned provider can degrade badly — a prod session measured 21-40s
 * to embed 10-52 token queries, dominating searchKnowledge's wall-clock.
 * `sort: "throughput"` routes around a degraded provider; `zdr` makes the
 * data policy explicit (Nebius/DeepInfra both qualify); the `quantizations`
 * floor keeps queries on the same quantization pool the indexed corpus was
 * embedded with (SiliconFlow serves fp8 — mixing quantizations between
 * corpus and query vectors adds retrieval noise). NO `require_parameters`
 * here: embeddings endpoints don't advertise `dimensions` in
 * supported_parameters, so it would empty the pool — the dimension check in
 * `embedQuery`/`embedBatch` already guards that contract.
 */
const embeddingsProvider = createOpenRouter({
  apiKey,
  extraBody: {
    dimensions: EMBEDDING_DIMENSIONS,
    usage: { include: true },
    provider: {
      zdr: true,
      sort: "throughput",
      quantizations: ["bf16", "fp16", "unknown"],
    },
  },
});

/**
 * The wrapped embedding model — `instrumentEmbeddingModel` attaches cost
 * capture + 20-input batching (preserving the prior batch size). Built once.
 */
const embeddingModel = instrumentEmbeddingModel(
  embeddingsProvider.textEmbeddingModel(embeddingModelId),
);

export const embedQuery = async (value: string): Promise<number[]> => {
  const { embedding } = await embed({
    model: embeddingModel,
    value,
    telemetry: telemetryFor("embeddings"),
  });

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${embedding.length}`,
    );
  }

  return embedding;
};

/**
 * Batch embed, preserving input order. `embedMany` chunks the values at the
 * model's `maxEmbeddingsPerCall` (set to 20 by the cost middleware) and runs
 * up to `EMBEDDING_PARALLEL_CALLS` of those batches concurrently. Each fp32
 * vector must be exactly `EMBEDDING_DIMENSIONS` long; callers
 * (`services/vectorize`) drop offenders defensively before insert.
 */
export const embedBatch = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return [];

  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: texts,
    maxParallelCalls: EMBEDDING_PARALLEL_CALLS,
    telemetry: telemetryFor("embeddings"),
  });

  for (const v of embeddings) {
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${v.length}`,
      );
    }
  }

  return embeddings;
};
