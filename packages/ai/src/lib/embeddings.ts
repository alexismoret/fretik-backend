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

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

/**
 * Max inputs per batch request. OpenRouter / OpenAI-compatible embedding
 * endpoints accept an array of strings in `input`. 20 is a safe cap that
 * keeps individual request bodies bounded (20 × ~2000 chars chunk + prefix
 * ≈ 40K payload), well under provider limits.
 */
const EMBEDDING_BATCH_SIZE = 20;

interface OpenRouterEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
}

const postEmbeddings = async (
  input: string | string[],
): Promise<number[][]> => {
  const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModelId,
      input,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenRouter embedding failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as OpenRouterEmbeddingResponse;
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
};

export const embedQuery = async (value: string): Promise<number[]> => {
  const [embedding] = await postEmbeddings(value);

  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${embedding?.length ?? 0}`,
    );
  }

  return embedding;
};

/**
 * Batch embed. Splits the input array into chunks of `EMBEDDING_BATCH_SIZE`,
 * calls the OpenRouter endpoint once per chunk, and reassembles the output
 * in input order. Each returned vector is fp32; conversion to the pgvector
 * `halfvec` literal happens at insert time in `services/vectorize/upsert.ts`.
 *
 * Throws if any vector comes back with a dimension count other than
 * `EMBEDDING_DIMENSIONS` — upstream callers (`services/vectorize`) drop
 * offending chunks defensively before the INSERT.
 */
export const embedBatch = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    batches.push(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
  }

  const results: number[][] = [];
  for (const batch of batches) {
    // oxlint-disable-next-line no-await-in-loop
    const vectors = await postEmbeddings(batch);
    if (vectors.length !== batch.length) {
      throw new Error(
        `OpenRouter embedding batch size mismatch: requested ${batch.length}, got ${vectors.length}`,
      );
    }
    for (const v of vectors) {
      if (v.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${v.length}`,
        );
      }
      results.push(v);
    }
  }

  return results;
};
