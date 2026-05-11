import type { HybridCandidate } from "./hybrid-search";

/**
 * Rerank the fused top-50 hybrid candidates with Cohere Rerank 4 Fast
 * via OpenRouter's `/rerank` endpoint. Native 100+ language support is
 * critical for Fretik's multilingual docs; staying on OpenRouter keeps
 * the whole stack on one API key / one provider.
 *
 * Pricing reference: ~$0.002 per search (1 query + N docs).
 *
 * Implementation note: the `ai` SDK v6 exposes a `rerank()` function,
 * but `@openrouter/ai-sdk-provider` 2.5.1 does not (yet) implement a
 * `rerankingModel()` method — only chat / completion / embedding /
 * image models. Rather than pulling in `@ai-sdk/cohere` (which would
 * add a second provider + API key and break
 * `keyDecisions.phase7Reranker`'s "stay on OpenRouter" rule) we call
 * OpenRouter's `/rerank` REST endpoint directly, mirroring the
 * existing `lib/embeddings.ts` pattern that also hits OpenRouter via
 * raw fetch.
 *
 * Failure policy:
 *   - Any HTTP error, network timeout, or malformed response → log
 *     and return the input list truncated to `topK`, preserving its
 *     original RRF order. Rerank is a quality enhancement, not a
 *     correctness gate — degrading to RRF-only is safe.
 *   - Circuit breaker: after `MAX_CONSECUTIVE_FAILURES` consecutive
 *     failures, skip the upstream call entirely for the rest of this
 *     process's lifetime. A restart re-enables it. This keeps the
 *     p95 latency flat when OpenRouter rerank has a bad day.
 */

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw "Missing OPENROUTER_API_KEY env";
}

const rerankModelId = process.env.OPENROUTER_RERANK_MODEL;
if (!rerankModelId) {
  throw "Missing OPENROUTER_RERANK_MODEL env";
}

const OPENROUTER_RERANK_URL = "https://openrouter.ai/api/v1/rerank";

/**
 * Hard timeout on the rerank HTTP call. Rerank-4-fast "high performance
 * lowest latency" tier handles 50 docs in well under 1s — 8s is a
 * crash-safety ceiling, not a working target.
 */
const RERANK_TIMEOUT_MS = 8_000;

const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * How long the breaker stays open before we probe the provider again.
 * 5 minutes balances "give the provider time to recover" with "don't
 * stay degraded all day after a 30-second blip". Previously the breaker
 * had no TTL and would stay open until the pod restarted.
 */
const BREAKER_RESET_MS = 5 * 60 * 1000;

/**
 * Circuit breaker state. Process-local (resets on restart) —
 * intentionally NOT Redis-backed because a rerank outage window is
 * short enough that a per-replica view of provider health is simpler
 * and good enough.
 */
let consecutiveFailures = 0;
let breakerOpen = false;
let breakerOpenedAt = 0;

export interface RerankedCandidate extends HybridCandidate {
  /** Cohere relevance score ∈ [0, 1]. Absent when rerank is skipped. */
  rerankScore: number | null;
}

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  results: CohereRerankResult[];
}

const buildDocumentText = (candidate: HybridCandidate): string =>
  candidate.contextualPrefix.length > 0
    ? `${candidate.contextualPrefix}\n\n${candidate.content}`
    : candidate.content;

const degradeToRrf = (
  candidates: HybridCandidate[],
  topK: number,
): RerankedCandidate[] =>
  candidates.slice(0, topK).map((c) => ({ ...c, rerankScore: null }));

/**
 * Calls OpenRouter `/rerank` with the query + candidate documents and
 * returns a reordered `RerankedCandidate[]` of length ≤ `topK`. On any
 * failure — HTTP, timeout, malformed response — returns the input
 * truncated to `topK` in its original RRF order.
 */
export const rerankCandidates = async (
  query: string,
  candidates: HybridCandidate[],
  topK: number,
): Promise<RerankedCandidate[]> => {
  if (candidates.length === 0) return [];
  if (topK <= 0) return [];
  if (breakerOpen) {
    if (Date.now() - breakerOpenedAt >= BREAKER_RESET_MS) {
      console.warn(
        "[reranker] circuit breaker cooldown elapsed — attempting a probe call",
      );
      breakerOpen = false;
      consecutiveFailures = 0;
    } else {
      return degradeToRrf(candidates, topK);
    }
  }

  const documents = candidates.map(buildDocumentText);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_RERANK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: rerankModelId,
        query,
        documents,
        top_n: Math.min(topK, candidates.length),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter rerank ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as CohereRerankResponse;
    if (!Array.isArray(json.results)) {
      throw new Error("OpenRouter rerank response missing results[]");
    }

    const reranked: RerankedCandidate[] = [];
    for (const r of json.results) {
      const candidate = candidates[r.index];
      if (!candidate) continue;
      reranked.push({ ...candidate, rerankScore: r.relevance_score });
    }

    consecutiveFailures = 0;
    return reranked.slice(0, topK);
  } catch (err) {
    consecutiveFailures++;
    console.warn(
      `[reranker] call failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), falling back to RRF:`,
      err instanceof Error ? err.message : err,
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      breakerOpen = true;
      breakerOpenedAt = Date.now();
      console.warn(
        `[reranker] circuit breaker OPEN — rerank disabled for ${BREAKER_RESET_MS / 1000}s, will probe again after cooldown`,
      );
    }
    return degradeToRrf(candidates, topK);
  } finally {
    clearTimeout(timeoutId);
  }
};

/** Reset breaker state — exposed for tests. */
export const __resetRerankerBreaker = (): void => {
  consecutiveFailures = 0;
  breakerOpen = false;
  breakerOpenedAt = 0;
};
