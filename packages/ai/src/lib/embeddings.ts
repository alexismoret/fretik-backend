import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { embed, embedMany } from "ai";
import {
  EMBEDDING_PROVIDER_POLICY,
  firstToAnswer,
  queryRoutesFor,
} from "./embedding-routes";
import { telemetryFor } from "./langfuse";
import { instrumentEmbeddingModel } from "./model-instrumentation";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("Missing OPENROUTER_API_KEY env");
}

const embeddingModelId = process.env.OPENROUTER_EMBEDDING_MODEL;
if (!embeddingModelId) {
  throw new Error("Missing OPENROUTER_EMBEDDING_MODEL env");
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
 * One OpenRouter embedding model, routed as `provider` says. Each call site
 * below builds its own ONCE, at module load.
 *
 * `@openrouter/ai-sdk-provider` v2.9.0 exposes no `dimensions` setting on
 * `textEmbeddingModel`, but its `doEmbed` spreads `config.extraBody` at the top
 * level of the request body — so the provider-level `extraBody` is how we send
 * the Matryoshka `dimensions` (load-bearing: the `halfvec(2560)` column depends
 * on it) plus usage accounting (`usage: { include: true }`) so OpenRouter
 * returns the real USD cost for the Langfuse `embedding` observation. A
 * separate instance keeps `dimensions` off the chat provider.
 *
 * NO `require_parameters`: embeddings endpoints don't advertise `dimensions` in
 * supported_parameters, so it would empty the pool — `assertDimensions` guards
 * that contract instead, on every vector.
 *
 * `instrumentEmbeddingModel` attaches cost capture + 20-input batching.
 */
const openRouterEmbeddingModel = (provider: Record<string, unknown>) =>
  instrumentEmbeddingModel(
    createOpenRouter({
      apiKey,
      extraBody: {
        dimensions: EMBEDDING_DIMENSIONS,
        usage: { include: true },
        provider,
      },
    }).textEmbeddingModel(embeddingModelId),
  );

type RoutedEmbeddingModel = ReturnType<typeof openRouterEmbeddingModel>;

/**
 * INDEXING: one request, OpenRouter's routing, under the shared data policy
 * (`EMBEDDING_PROVIDER_POLICY` — ZDR and the quantization floor).
 *
 * History (2026-07-21): without preferences OpenRouter price-sorts, and a
 * pinned provider was measured at 21-40 s for 10-52 token queries, so
 * `sort: "throughput"` was added to route around a degraded provider. It does
 * not: OpenRouter publishes no throughput or latency statistics for embedding
 * endpoints, and the sort sent 40 of 40 calls to Nebius (measured 2026-09-24,
 * `lib/embedding-routes.ts`). Kept here because indexing has no deadline and
 * works; the QUERY path, which does have one, does not rely on it.
 */
const embeddingModel = openRouterEmbeddingModel({
  ...EMBEDDING_PROVIDER_POLICY,
  sort: "throughput",
});

/**
 * QUERIES: one model per measured route, each pinned to its provider
 * (`only` + `allow_fallbacks: false`, so a route is exactly one provider and
 * the race is between providers, not between two draws of the same routing).
 * Empty for a model with no measured routes: queries then take the indexing
 * model — see `onQueryRoutes`.
 */
const queryRouteModels: readonly RoutedEmbeddingModel[] = queryRoutesFor(
  embeddingModelId,
).map((slug) =>
  openRouterEmbeddingModel({
    ...EMBEDDING_PROVIDER_POLICY,
    only: [slug],
    allow_fallbacks: false,
  }),
);

/**
 * Every vector must be exactly `EMBEDDING_DIMENSIONS` long, or it cannot enter
 * (or be compared against) the `halfvec(2560)` column. Inside a race this runs
 * per route, so a provider that starts ignoring `dimensions` loses the race
 * instead of winning it with vectors nobody can use.
 */
const assertDimensions = (vectors: readonly number[][]): void => {
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${v.length}`,
      );
    }
  }
};

/**
 * Bound the wait, for callers that have one.
 *
 * Deliberately optional and never defaulted here: the query path has a user
 * waiting and a lexical fallback already wired, while indexing has neither —
 * a document that failed to embed is a document that stays unsearchable, so
 * ingest must be allowed to take as long as the provider takes.
 */
export interface EmbedOptions {
  abortSignal?: AbortSignal;
}

/**
 * Run a query embedding on every measured route at once and keep the first
 * answer (`firstToAnswer`); with no measured route, run it once on the
 * indexing model. `run` receives the model and the signal to honour — the
 * caller's deadline, plus the race's own cancellation when there is one.
 */
const onQueryRoutes = <T>(
  run: (model: RoutedEmbeddingModel, abortSignal?: AbortSignal) => Promise<T>,
  options?: EmbedOptions,
): Promise<T> =>
  queryRouteModels.length === 0
    ? run(embeddingModel, options?.abortSignal)
    : firstToAnswer(
        queryRouteModels.map((model) => (signal) => run(model, signal)),
        options?.abortSignal,
      );

/**
 * One QUERY, embedded for a person who is waiting: raced across the measured
 * routes (`lib/embedding-routes.ts`). Pass the caller's deadline as
 * `abortSignal`.
 */
export const embedQuery = (
  value: string,
  options?: EmbedOptions,
): Promise<number[]> =>
  onQueryRoutes(async (model, abortSignal) => {
    const { embedding } = await embed({
      model,
      value,
      abortSignal,
      telemetry: telemetryFor("embeddings"),
    });
    assertDimensions([embedding]);
    return embedding;
  }, options);

/**
 * Several QUERIES at once (the multi-query expansion's cache misses), raced
 * like `embedQuery`, returned in input order. A handful of short strings: one
 * request per route, no parallel batching.
 */
export const embedQueries = async (
  texts: string[],
  options?: EmbedOptions,
): Promise<number[][]> => {
  if (texts.length === 0) return [];
  return onQueryRoutes(async (model, abortSignal) => {
    const { embeddings } = await embedMany({
      model,
      values: texts,
      abortSignal,
      telemetry: telemetryFor("embeddings"),
    });
    assertDimensions(embeddings);
    return embeddings;
  }, options);
};

/**
 * INDEXING batch embed, preserving input order — never raced: nobody is
 * waiting, the batches are large, and doubling them would double real money.
 * `embedMany` chunks the values at the model's `maxEmbeddingsPerCall` (set to
 * 20 by the cost middleware) and runs up to `EMBEDDING_PARALLEL_CALLS` of
 * those batches concurrently. Callers (`services/vectorize`) drop offenders
 * defensively before insert.
 */
export const embedBatch = async (
  texts: string[],
  options?: EmbedOptions,
): Promise<number[][]> => {
  if (texts.length === 0) return [];

  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: texts,
    maxParallelCalls: EMBEDDING_PARALLEL_CALLS,
    abortSignal: options?.abortSignal,
    telemetry: telemetryFor("embeddings"),
  });
  assertDimensions(embeddings);
  return embeddings;
};
