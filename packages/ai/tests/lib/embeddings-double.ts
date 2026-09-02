/**
 * The embedding and enrichment boundary, doubled — because OpenRouter is a
 * PROCESS BOUNDARY, and an integration test crosses none.
 *
 * The four suites that use this ran against the real OpenRouter until
 * 2026-09-02. Their own headers said so ("These tests hit the real DB AND real
 * OpenRouter"), and it was true in exactly one direction: on a laptop, where
 * `.env` supplies a key, every run paid for real embeddings and one cheap-model
 * call per chunk. CI has no key, so `test-env.ts`'s placeholder went to the wire
 * and came back `401 Missing Authentication header` — 14 red tests the first
 * time the integration job ever ran against a database.
 *
 * Neither half of that is a good outcome, and they are the same defect: a test
 * whose verdict depends on an ambient secret. What these suites are actually
 * about is SQL — which rows get written, which stale rows get cleared, which
 * scope columns land NULL, which `source_id` a re-vectorisation reuses. The
 * vector is an INPUT to that, not the subject, and every assertion in the four
 * files is on a column, never on a coordinate.
 *
 * What is genuinely lost: nothing here now proves that Qwen3-Embedding-8B is
 * reachable, returns 2560 dimensions, or that the cheap enrichment model still
 * answers. That was never this suite's job — `models:check -- --probe` and the
 * evals talk to the live providers, deliberately, where a provider outage
 * reddens the thing it should redden and not a pull request.
 */
import { EMBEDDING_DIMENSIONS } from "../../src/lib/embeddings";
import { mockModule } from "./mock-module";

/** FNV-1a. Stable across runs and platforms, which `Math.random` is not. */
const hashToken = (token: string): number => {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * A deterministic unit vector per TOKEN, summed into a vector per text — the
 * hashing trick, and the reason this is not just `hash(text) → noise`.
 *
 * `hybrid-search.test.ts` seeds nine rows whose contents deliberately share
 * vocabulary with the query, and says why in its own comment: "completely
 * off-topic seeds risk falling out of the top-150 cut entirely". A double that
 * gave every distinct string an orthogonal vector would silently remove the one
 * property that suite leans on. Summing per-token vectors keeps it: texts
 * sharing words score above texts that share none, monotonically in how many
 * they share.
 */
const tokenVector = (token: string, out: Float64Array): void => {
  let state = hashToken(token) || 1;
  for (let i = 0; i < out.length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = (out[i] ?? 0) + (state / 0xffffffff - 0.5);
  }
};

/** L2-normalised, so cosine similarity is a dot product and stays in [-1, 1]. */
export const fakeEmbedding = (text: string): number[] => {
  const acc = new Float64Array(EMBEDDING_DIMENSIONS);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? ["∅"];
  for (const token of tokens) tokenVector(token, acc);

  let norm = 0;
  for (const x of acc) norm += x * x;
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;

  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < out.length; i++) out[i] = (acc[i] ?? 0) * inv;
  return out;
};

/**
 * Install both doubles. Call at the TOP of an integration file, before the
 * subject is imported — `mockModule` spreads over the real module, so
 * `EMBEDDING_DIMENSIONS` and everything else stays real and the `halfvec(2560)`
 * contract is still the production one.
 */
export const installEmbeddingDoubles = async (): Promise<void> => {
  await mockModule("../../src/lib/embeddings", {
    embedQuery: async (value: string) => fakeEmbedding(value),
    embedBatch: async (texts: string[]) => texts.map(fakeEmbedding),
  });

  /**
   * A NON-EMPTY prefix, which is the point: `vectorizeSource` joins the
   * semantic header to the enrichment text only when the latter is non-empty
   * (`${semanticHeader}\n${prefix}`), and the tests assert `toContain("path:…")`
   * on the result. Returning "" — what production does when the cheap model
   * fails, and what CI was getting from its 401 — would exercise the degraded
   * branch instead of the one every deployment takes.
   */
  await mockModule("../../src/services/vectorize/contextual-enrichment", {
    enrichChunks: async (
      _docContent: string,
      chunks: { index: number; totalChunks: number; content: string }[],
    ) =>
      chunks.map((chunk) => ({
        index: chunk.index,
        totalChunks: chunk.totalChunks,
        content: chunk.content,
        contextualPrefix: `Situated chunk ${chunk.index + 1} of ${chunk.totalChunks}.`,
      })),
  });
};
