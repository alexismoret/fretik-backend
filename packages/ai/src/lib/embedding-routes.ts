/**
 * Where an embedding request goes, and how a QUERY embedding outruns a slow
 * provider.
 *
 * Two paths embed, and they want different things:
 *
 * - INDEXING (documents, memories, episodes, cards) has nobody waiting and a
 *   lot to send. It makes one request per batch through OpenRouter's own
 *   routing, and waits as long as that takes (`lib/embeddings.embedBatch`).
 * - A QUERY (pre-turn recall, `searchKnowledge`) has a person waiting, and a
 *   query that misses its deadline is a search served without its semantic
 *   arm. It sends the same request to every provider measured for the model
 *   at once, and takes the first answer (`embedQuery` / `embedQueries`).
 *
 * Why a race and not a better sort, measured 2026-09-24 on
 * `qwen/qwen3-embedding-8b` (40 rounds per routing, interleaved so each saw the
 * same conditions, a 3-query batch like recall's):
 *
 *   routing                      p50     p90     max    past 5 s
 *   sort "throughput" (before)   1.65 s  6.3 s  10.0 s   7 / 40
 *   sort "latency"               1.26 s  6.4 s   9.5 s   6 / 40
 *   Nebius alone                 0.77 s  7.0 s  12.8 s   7 / 40
 *   DeepInfra alone              0.90 s  2.6 s   3.9 s   0 / 40
 *   both at once, first wins     0.60 s  1.65 s  2.6 s   0 / 40
 *
 * OpenRouter's `sort` cannot do this job: it ranks endpoints by latency and
 * throughput statistics it does not publish for embedding models
 * (`latency_last_30m` and `throughput_last_30m` are null on every endpoint),
 * and sent 40 of 40 calls to Nebius under "throughput" and "latency" alike.
 * Pinning the faster provider instead would be a bet on one afternoon: over the
 * week before, Nebius was the fast one (0.21 s median in production). The two
 * providers' slow spells do not coincide, so asking both absorbs whichever one
 * is having it. An extra route costs one more request, about $0.0000001 for a
 * query: a hundred thousand queries a day is a cent.
 */

/**
 * The data policy EVERY embedding request carries, indexing and query alike,
 * so no route can be added that sidesteps it:
 *
 * - `zdr`: zero data retention, stated on the wire rather than trusted;
 * - `quantizations`: the precision the corpus was embedded at. A vector from a
 *   quantized endpoint is not the same vector (SiliconFlow serves this model in
 *   fp8, which is why it is not a route), and mixing them between corpus and
 *   query adds retrieval noise nobody sees. `unknown` is how OpenRouter labels
 *   the full-precision endpoints that do not state it (Nebius, DeepInfra).
 *
 * A route that stops qualifying fails its own request, and the others answer.
 */
export const EMBEDDING_PROVIDER_POLICY: {
  zdr: boolean;
  quantizations: string[];
} = {
  zdr: true,
  quantizations: ["bf16", "fp16", "unknown"],
};

/**
 * The providers a query embedding is raced across, per embedding model: a
 * provider list only means something for the model it was measured on.
 *
 * A provider belongs here when `bun run measure:embedding-routes` shows all
 * three, for this model:
 *
 * 1. it answers at the index's dimension (`EMBEDDING_DIMENSIONS`);
 * 2. its vectors are interchangeable with the others' — cosine ≥ 0.9999 on the
 *    same texts. The index was embedded by whichever provider indexing reached,
 *    so a query vector from any route must land where theirs would have
 *    (Nebius against DeepInfra: 0.99991 to 0.99996, i.e. arithmetic noise);
 * 3. it passes `EMBEDDING_PROVIDER_POLICY`.
 *
 * The values are OpenRouter provider slugs, as `provider.only` takes them.
 *
 * A model with NO entry gets a single request through OpenRouter's routing —
 * the behaviour before the race. So changing `OPENROUTER_EMBEDDING_MODEL`
 * never breaks the query path (the corpus has to be re-embedded anyway); it
 * only runs without the race until someone measures routes for the new model.
 * One route is allowed and means "always this provider".
 *
 * Moving embeddings off OpenRouter altogether keeps this shape: the race below
 * takes functions and knows nothing of providers, so a route becomes whatever
 * builds a model on the new transport, and the key stays the model id.
 */
export const QUERY_EMBEDDING_ROUTES: Readonly<
  Record<string, readonly string[]>
> = {
  "qwen/qwen3-embedding-8b": ["nebius", "deepinfra"],
};

export const queryRoutesFor = (modelId: string): readonly string[] =>
  QUERY_EMBEDDING_ROUTES[modelId] ?? [];

/**
 * Run every attempt at once and resolve with the first that SUCCEEDS; the rest
 * are cancelled.
 *
 * - An attempt that fails does not end the race: a provider returning a 5xx,
 *   or an answer the attempt itself rejects (a wrong dimension), leaves the
 *   others to answer.
 * - When every attempt fails, the error names each failure.
 * - The caller's `signal` (its deadline) ends the race outright, and is what
 *   the caller gets back — a timeout reads as a timeout, not as "every route
 *   failed".
 * - The attempts that lose are aborted with an `AbortError` saying so, so a
 *   cancelled request is never mistaken for a timed-out one in a log, and the
 *   SDK does not retry it.
 */
export const firstToAnswer = async <T>(
  attempts: readonly ((signal: AbortSignal) => Promise<T>)[],
  signal?: AbortSignal,
): Promise<T> => {
  if (attempts.length === 0) throw new Error("firstToAnswer: nothing to run");
  const race = new AbortController();
  const shared =
    signal === undefined ? race.signal : AbortSignal.any([signal, race.signal]);
  try {
    return await Promise.any(attempts.map((attempt) => attempt(shared)));
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason));
    }
    if (error instanceof AggregateError) {
      const reasons = error.errors.map((e: unknown) =>
        e instanceof Error ? e.message : String(e),
      );
      throw new Error(`every route failed: ${reasons.join("; ")}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    race.abort(new DOMException("another route answered first", "AbortError"));
  }
};
