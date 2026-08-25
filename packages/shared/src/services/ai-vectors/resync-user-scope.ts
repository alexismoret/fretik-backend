import { and, eq, sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import type { AiVectorSourceType } from "../../db/schema";
import { aiVectors } from "../../db/schema";

/**
 * Move a source's already-indexed vectors to a new owner, in one statement.
 *
 * This exists because access control and retrieval quality live in two
 * different places, and only one of them can wait.
 *
 * Who may see a vector is decided by the `user_id` COLUMN — `hybrid-search`
 * filters on `(user_id IS NULL OR user_id = $viewer)`. The card TEXT's
 * visibility line is what makes the embedding say the right thing; it gates
 * nobody. So when a page or workflow flips between team-shared and private,
 * the column has to move inside the mutation's own transaction, while the text
 * can be rewritten later by the usual fire-and-forget refresh.
 *
 * Without this, a dropped refresh — the refreshers swallow every error, so
 * "dropped" is a normal outcome, not an exotic one — left a privatised page
 * readable by the whole team until somebody happened to save it again.
 *
 * No embedding, no AI-service round-trip: the rows keep their content and
 * their vector, they change hands. Served by `idx_ai_vectors_source`, and
 * `IS DISTINCT FROM` makes it a no-op on every save that is not a scope change.
 *
 * `updated_at` is deliberately preserved, so it keeps pointing at the last time
 * the TEXT was verified — which is what lets the reconciliation sweep notice
 * the card is now stale and rewrite it. Assigning the column to itself is how
 * that is expressed: `aiVectors.updatedAt` carries a `$onUpdateFn`, which
 * Drizzle appends to every `.set()` that does NOT name the field, so leaving it
 * out would stamp `now()` and hide the staleness (verified against the
 * generated SQL).
 */
export const resyncVectorUserScope = async (params: {
  sourceType: AiVectorSourceType;
  sourceId: string;
  /** The new owner; `null` when the source becomes team-shared. */
  userId: string | null;
  tx?: Transaction;
}): Promise<number> => {
  const rows = await (params.tx ?? db)
    .update(aiVectors)
    .set({ userId: params.userId, updatedAt: sql`${aiVectors.updatedAt}` })
    .where(
      and(
        eq(aiVectors.sourceType, params.sourceType),
        eq(aiVectors.sourceId, params.sourceId),
        sql`${aiVectors.userId} IS DISTINCT FROM ${params.userId}`,
      ),
    )
    .returning({ id: aiVectors.id });
  return rows.length;
};
