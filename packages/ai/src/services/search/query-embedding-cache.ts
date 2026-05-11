import { deleteKeysByPrefix, redis } from "@fretik/shared/lib/redis";
import {
  EMBEDDING_DIMENSIONS,
  embedBatch,
  embedQuery,
} from "../../lib/embeddings";

/**
 * Redis-backed LRU + TTL cache for query-path embeddings.
 *
 * Scope: the RAG orchestrator embeds the user's query (plus 2
 * multi-query reformulations) on every turn. Within a conversation the
 * same question often surfaces two or three times (follow-ups,
 * clarifications, typos); across users, popular product questions
 * repeat frequently. Caching the fp32 vector sidesteps a round-trip to
 * OpenRouter's Qwen3-Embedding-8B endpoint (~200-500 ms for a 3-entry
 * batch), saves ~2e6 embedding tokens per 1000 cached hits, and keeps
 * the rerank stage deterministic on repeat queries.
 *
 * Why Redis and not in-process: @fretik/ai is horizontally scaled. An
 * in-process `Map` would fragment the cache across N replicas — a user
 * bouncing across replicas would miss on every first turn per replica
 * and the global hit rate would collapse. Redis keeps one shared cache,
 * so a popular query that lands on replica A gets served from replica B
 * next minute. The ~1-2 ms Redis round-trip is negligible against the
 * 200-500 ms embedding round-trip it replaces.
 *
 * Storage: raw fp32 as a `Buffer` view over `Float32Array.buffer`. At
 * 2560 dims × 4 bytes, each entry is 10 KB on the wire — ~50 % smaller
 * than `JSON.stringify(number[])` and it avoids the parse cost on read.
 * At the 1000-entry cap this is 10 MB of Redis memory; scalable under
 * real traffic to ~100 MB before TTL catches up.
 *
 * Scope limits: ONLY the query path. Ingest embeddings (`services/
 * vectorize/embedder.ts`) bypass this cache — they're persisted once in
 * `ai_vectors` and never re-embedded, so caching would just waste
 * RAM.
 *
 * Keying: `sha256(model:dimensions:query)` as hex — the model id and
 * dimension are part of the key so a `.env` swap (model upgrade,
 * Matryoshka truncation change) never serves stale vectors from a
 * previous config.
 *
 * Eviction: a ZSET (`qec:lru`) tracks last-access timestamps keyed by
 * the full cache key. After every write we call `enforceBound` — if
 * `ZCARD` is over `MAX_ENTRIES` we pop the oldest (lowest score) and
 * delete both the entry key and its ZSET member in one pipeline. This
 * gives a strict 1000-entry global cap no matter how bursty traffic
 * gets, which is what the plan mandates.
 *
 * TTL: 1h. Queries evolve with the product (new shipment types, new
 * trade lanes); an hour-old embedding is still technically valid but
 * not worth holding indefinitely — the 1000-entry cap is the primary
 * defense against drift, the TTL is a secondary sweep that also
 * reclaims memory when traffic dies down on a weekend.
 *
 * Observability: hit / miss counters kept in-process (per-replica).
 * Mature chatbot should trend towards 15-30 % hit rate on a busy tenant;
 * anomalous drops (< 5 %) suggest broken keying (e.g. upstream adding a
 * timestamp into the query) or a cache bypass.
 *
 * @see chatbot-overhaul-plan.md Phase 8 task 8.5
 */

const KEY_PREFIX = "qec:";
const LRU_ZSET = "qec:lru";
const TTL_SECONDS = 60 * 60;
const MAX_ENTRIES = 1000;

const EMBEDDING_MODEL_ID = process.env.OPENROUTER_EMBEDDING_MODEL ?? "unknown";

const BYTES_PER_FP32 = 4;
const EXPECTED_BUFFER_BYTES = EMBEDDING_DIMENSIONS * BYTES_PER_FP32;

let hits = 0;
let misses = 0;

const hashKey = (query: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${EMBEDDING_MODEL_ID}:${EMBEDDING_DIMENSIONS}:${query}`);
  return `${KEY_PREFIX}${hasher.digest("hex")}`;
};

const encodeEmbedding = (embedding: number[]): Buffer => {
  const view = new Float32Array(embedding);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
};

const decodeEmbedding = (buf: Buffer): number[] | null => {
  if (buf.byteLength !== EXPECTED_BUFFER_BYTES) return null;
  // Copy into a fresh ArrayBuffer to guarantee byte alignment — ioredis
  // can return a Buffer that's a view over a shared pool, whose byteOffset
  // might not be a multiple of 4 (required for a Float32Array view).
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  const view = new Float32Array(copy.buffer);
  return Array.from(view);
};

const enforceBound = async (): Promise<void> => {
  const size = await redis.zcard(LRU_ZSET);
  if (size <= MAX_ENTRIES) return;
  const excess = size - MAX_ENTRIES;
  const oldest = await redis.zrange(LRU_ZSET, 0, excess - 1);
  if (oldest.length === 0) return;
  const pipeline = redis.pipeline();
  pipeline.zrem(LRU_ZSET, ...oldest);
  for (const key of oldest) pipeline.del(key);
  await pipeline.exec();
};

export interface QueryEmbeddingCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
}

/**
 * Per-replica hit / miss counters. The underlying cache data is shared
 * across replicas via Redis, but these counters are process-local — use
 * them for anomaly detection on a given replica rather than a global
 * hit rate. For a global view, aggregate across replicas (e.g. via your
 * metrics pipeline).
 */
export const getQueryEmbeddingCacheStats = (): QueryEmbeddingCacheStats => {
  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total === 0 ? 0 : hits / total,
  };
};

/**
 * Drop every cached entry and reset counters. Intended for tests —
 * production code should not call this; the TTL + bounded LRU handle
 * hygiene. Uses `deleteKeysByPrefix` (SCAN-based) to avoid the O(N)
 * `KEYS` anti-pattern.
 */
export const clearQueryEmbeddingCache = async (): Promise<void> => {
  await deleteKeysByPrefix(KEY_PREFIX);
  await redis.del(LRU_ZSET);
  hits = 0;
  misses = 0;
};

/**
 * Returns the cached embedding for `query` when present, otherwise
 * calls `embedQuery`, caches, and returns the fresh vector.
 */
export const getCachedOrEmbed = async (query: string): Promise<number[]> => {
  const key = hashKey(query);
  const buf = await redis.getBuffer(key);
  if (buf) {
    const decoded = decodeEmbedding(buf);
    if (decoded) {
      hits += 1;
      await redis.zadd(LRU_ZSET, Date.now(), key);
      return decoded;
    }
    // Corrupted payload — fall through to re-embed and overwrite.
    await redis.del(key);
  }

  misses += 1;
  const embedding = await embedQuery(query);
  const pipeline = redis.pipeline();
  pipeline.set(key, encodeEmbedding(embedding), "EX", TTL_SECONDS);
  pipeline.zadd(LRU_ZSET, Date.now(), key);
  await pipeline.exec();
  await enforceBound();
  return embedding;
};

/**
 * Batch variant — hits are served from cache, misses are batch-embedded
 * in a single OpenRouter call, and the result is returned in the input
 * order. Used by `services/search/index.ts` for the multi-query (3
 * variants) expansion: the original query is almost always cached by the
 * second turn in a conversation, so this typically degrades to a 2-entry
 * batch (or even a 0-entry no-op).
 */
interface BatchMiss {
  index: number;
  key: string;
  query: string;
}

export const getCachedOrEmbedBatch = async (
  queries: string[],
): Promise<number[][]> => {
  if (queries.length === 0) return [];

  const keys = queries.map(hashKey);
  const buffers = await redis.mgetBuffer(...keys);
  const results: (number[] | undefined)[] = Array.from(
    { length: queries.length },
    () => undefined,
  );
  const missList: BatchMiss[] = [];

  const hitPipeline = redis.pipeline();
  let hadHit = false;
  const now = Date.now();

  for (const [i, query] of queries.entries()) {
    const key = keys[i];
    if (key === undefined) continue;
    const buf = buffers[i];
    if (buf) {
      const decoded = decodeEmbedding(buf);
      if (decoded) {
        hits += 1;
        hadHit = true;
        results[i] = decoded;
        hitPipeline.zadd(LRU_ZSET, now, key);
        continue;
      }
      // Corrupted payload — treat as a miss and let the write path
      // overwrite it.
      hitPipeline.del(key);
      hadHit = true;
    }
    missList.push({ index: i, key, query });
  }
  if (hadHit) await hitPipeline.exec();

  if (missList.length > 0) {
    misses += missList.length;
    const fresh = await embedBatch(missList.map((m) => m.query));
    const missPipeline = redis.pipeline();
    for (const [j, miss] of missList.entries()) {
      const vec = fresh[j];
      if (!vec) continue;
      results[miss.index] = vec;
      missPipeline.set(miss.key, encodeEmbedding(vec), "EX", TTL_SECONDS);
      missPipeline.zadd(LRU_ZSET, Date.now(), miss.key);
    }
    await missPipeline.exec();
    await enforceBound();
  }

  return results.map((r) => r ?? []);
};
