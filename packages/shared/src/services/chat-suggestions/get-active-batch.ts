import db from "../../db";
import type { ChatSuggestionKind } from "../../db/schema";

/**
 * The reader's current batch of suggestions, or `null` when they have none.
 *
 * Scoped to (user, team) with no exception: the context these are written from
 * carries the reader's PRIVATE episodes and memories, so serving another
 * user's row would be a leak, not a nicety. The integration test deletes the
 * `userId` predicate for exactly that reason.
 *
 * A batch is the rows sharing the newest `batchId`. In practice only one batch
 * is ever `active` — `replaceSuggestionBatch` supersedes the previous one in
 * the same transaction — but reading the newest rather than assuming keeps a
 * half-applied write from mixing two generations on screen.
 */
export interface SuggestionBatchItem {
  id: string;
  kind: ChatSuggestionKind;
  label: string;
  prompt: string;
  reason: string;
}

export interface SuggestionBatch {
  batchId: string;
  inputHash: string;
  modelKey: string;
  createdAt: Date;
  items: SuggestionBatchItem[];
}

export const getActiveSuggestionBatch = async (params: {
  userId: string;
  teamId: string;
}): Promise<SuggestionBatch | null> => {
  const rows = await db.query.chatSuggestions.findMany({
    where: {
      userId: params.userId,
      teamId: params.teamId,
      status: "active",
    },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return null;

  // `batchId` is a v7 uuid, so the lexicographic max is the newest batch.
  const newestBatchId = rows.reduce(
    (max, row) => (row.batchId > max ? row.batchId : max),
    rows[0]?.batchId ?? "",
  );
  const batchRows = rows.filter((row) => row.batchId === newestBatchId);
  const first = batchRows[0];
  if (!first) return null;

  return {
    batchId: newestBatchId,
    inputHash: first.inputHash,
    modelKey: first.modelKey,
    createdAt: first.createdAt,
    items: batchRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      prompt: row.prompt,
      reason: row.reason,
    })),
  };
};
