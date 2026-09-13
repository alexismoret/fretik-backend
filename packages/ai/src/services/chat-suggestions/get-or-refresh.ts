import { redis } from "@fretik/shared/lib/redis";
import type { ChatSuggestionsResponse } from "@fretik/shared/schemas/chat-suggestions";
import {
  getActiveSuggestionBatch,
  type SuggestionBatch,
} from "@fretik/shared/services/chat-suggestions/get-active-batch";
import { replaceSuggestionBatch } from "@fretik/shared/services/chat-suggestions/replace-batch";
import { decideFreshness } from "./freshness";
import { generateSuggestions } from "./generate";
import { renderSuggestionPack, type SuggestionPack } from "./pack";
import { loadSuggestionSources } from "./sources";

/**
 * What the home screen asks for, and the only place that decides whether a
 * model runs.
 *
 * The shape is stale-while-revalidate, with one exception in each direction.
 * A reader who has never had suggestions waits for a real generation — there
 * is nothing else to show them. A workspace with nothing to personalise from
 * never generates at all: `coldStart` comes back and the client draws its
 * static starter cards, which is a better answer than a paid-for generic one.
 *
 * `CHAT_SUGGESTIONS_ENABLED=false` turns the whole thing off without a deploy.
 * Read per call, not at module load, so flipping it in the environment takes
 * effect on the next request rather than the next restart — this one is a
 * spend switch, and a spend switch nobody can reach in a hurry is not one.
 */

const REFRESH_LOCK_TTL_SECONDS = 60;

const isEnabled = (): boolean =>
  (process.env.CHAT_SUGGESTIONS_ENABLED ?? "true") !== "false";

const serve = (
  batch: SuggestionBatch | null,
  coldStart: boolean,
): ChatSuggestionsResponse => ({
  items: batch?.items ?? [],
  coldStart,
  generatedAt: batch?.createdAt ?? null,
});

export interface SuggestionRequest {
  organizationId: string;
  teamId: string;
  userId: string;
  /** The reader's UI language — what the suggestions are written in. */
  language: string;
  /** Regenerate regardless of freshness (the explicit refresh button). */
  force?: boolean;
}

const writeBatch = async (
  request: SuggestionRequest,
  pack: SuggestionPack,
): Promise<SuggestionBatch | null> => {
  const generated = await generateSuggestions({
    teamId: request.teamId,
    userId: request.userId,
    pack,
  });
  if (!generated || generated.items.length === 0) return null;

  return replaceSuggestionBatch({
    organizationId: request.organizationId,
    teamId: request.teamId,
    userId: request.userId,
    inputHash: pack.inputHash,
    modelKey: generated.modelKey,
    items: generated.items.map((item) => ({
      kind: item.kind,
      label: item.label,
      prompt: item.prompt,
      reason: item.reason,
      sourceRefs: item.sourceIds,
    })),
  });
};

/**
 * Regenerate behind the reader's back. Guarded by a Redis lock rather than a
 * promise in memory: two tabs, or two replicas, would otherwise each spend a
 * call to write the same batch. Whoever loses the lock simply returns — the
 * winner's rows are what the next request reads.
 */
const refreshInBackground = async (
  request: SuggestionRequest,
  pack: SuggestionPack,
): Promise<void> => {
  const lockKey = `chat-suggestions:lock:${request.teamId}:${request.userId}`;
  const acquired = await redis.set(
    lockKey,
    "1",
    "EX",
    REFRESH_LOCK_TTL_SECONDS,
    "NX",
  );
  if (acquired === null) return;
  try {
    await writeBatch(request, pack);
  } finally {
    await redis.del(lockKey);
  }
};

export const getOrRefreshSuggestions = async (
  request: SuggestionRequest,
): Promise<ChatSuggestionsResponse> => {
  if (!isEnabled()) return serve(null, true);

  const sources = await loadSuggestionSources({
    organizationId: request.organizationId,
    teamId: request.teamId,
    userId: request.userId,
  });
  const pack = renderSuggestionPack(sources, {
    language: request.language,
    now: new Date(),
  });
  const batch = await getActiveSuggestionBatch({
    userId: request.userId,
    teamId: request.teamId,
  });

  // Nothing to personalise from and nothing already written: say so instead of
  // paying a model to be generic.
  if (pack.isCold && !batch) return serve(null, true);

  const decision = request.force
    ? "generate"
    : decideFreshness(batch, pack.inputHash, new Date());

  if (decision === "serve") return serve(batch, false);

  if (decision === "generate") {
    const fresh = await writeBatch(request, pack);
    return serve(fresh ?? batch, false);
  }

  // serve-and-refresh: answer from what exists, rewrite underneath.
  void refreshInBackground(request, pack).catch((error: unknown) => {
    console.warn(
      "[chat-suggestions] background refresh failed:",
      error instanceof Error ? error.message : error,
    );
  });
  return serve(batch, false);
};
