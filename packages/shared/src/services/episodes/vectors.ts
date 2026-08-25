import { and, eq, inArray } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { aiVectors } from "../../db/schema";

/**
 * Drop the recall-index rows of episodes (demotion, supersession). Direct
 * SQL — nothing to embed, no AI-service roundtrip. The episode rows stay:
 * re-promotion = re-vectorize (idempotent pipeline).
 *
 * THROWS BY DESIGN — do not wrap the body in a try/catch. Four callers await
 * it for correctness, and the loudest is `consolidateEpisodes`: it drops the
 * SUPERSEDED episodes' vectors right after writing the survivor's, so a
 * swallowed failure would leave both in recall — the exact duplication
 * consolidation exists to remove. Callers that genuinely do not care log it
 * themselves.
 *
 * Pass `tx` when the episodes were hidden inside a transaction: the demotion
 * and the vector drop must commit together, or a rollback leaves a live
 * episode with no vectors and nothing to rebuild them. Same rule as
 * `documents/delete.ts`, which deletes `ai_vectors` inside the mutation's tx.
 */
export const deleteEpisodeVectors = async (
  episodeIds: string[],
  tx?: Transaction,
): Promise<void> => {
  if (episodeIds.length === 0) return;
  await (tx ?? db)
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "episodes"),
        inArray(aiVectors.sourceId, episodeIds),
      ),
    );
};
