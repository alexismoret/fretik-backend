import { sql } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { aiVectors } from "../../db/schema";
import { redis, selectOrCache } from "../../lib/redis";
import {
  analyzeCollectionTable,
  estimatedRowCount,
} from "../collection-schema/indexes";

/**
 * Which collections get a SEMANTIC card per record — the size policy behind
 * `source_type='records'` in `ai_vectors`.
 *
 * Why a ceiling at all: one card is one embedding call and one vector row, so a
 * 200 000-row import is 200 000 embeddings and 200 000 HNSW entries for a type
 * nobody searches by meaning — they filter it, sort it, aggregate it. The cost
 * is paid on every import and the recall value collapses at that size: a
 * top-k semantic sweep over 200 000 near-identical rows returns an arbitrary
 * handful.
 *
 * Why NOT eviction by age (the obvious alternative): dropping the oldest cards
 * to keep a fixed budget makes retrieval silently and non-deterministically
 * incomplete — the client imported three months ago stops existing, and in B2B
 * the oldest record is often the biggest account. This policy never removes
 * what it promised: a type is indexed or it is not, and the answer depends on
 * the type's size, not on a row's age.
 *
 * What replaces semantic search above the ceiling: `collection_records.search_vector`
 * — a different column, GIN-indexed, maintained on every write including bulk,
 * complete at any volume and free. The hybrid search reads it as its own arm,
 * so a record above the ceiling is still findable by name. The ceiling costs
 * the "the client in Lyon" phrasing on huge types, never findability.
 */

/**
 * Rows above which a type stops being embedded record by record.
 *
 * Deliberately its OWN constant rather than an alias of `INDEX_ROW_THRESHOLD`,
 * even though the two numbers coincide today: "big enough to deserve SQL
 * indexes" and "too big to embed row by row" are different decisions, driven by
 * different costs (planner time vs embedding spend), and they must be free to
 * move apart.
 */
export const CARD_INDEX_ROW_CEILING = 20_000;

/** How long a type's verdict is reused. Amortises the ANALYZE below. */
const POLICY_CACHE_TTL_S = 5 * 60;

const policyCacheKey = (collectionId: string): string =>
  `card-index-policy:${collectionId}`;

/**
 * The verdict, from the type's stored preference and a row estimate.
 *
 * `semanticIndex` is the escape hatch on top of the heuristic: `true` keeps a
 * huge type indexed (a 50 000-row client list where semantic search is the
 * whole point), `false` takes a small one out (a noisy log-like type that
 * pollutes recall), `null` lets the size decide.
 */
export const cardIndexVerdict = (input: {
  preference: boolean | null;
  rows: number;
}): boolean => input.preference ?? input.rows < CARD_INDEX_ROW_CEILING;

/**
 * True when a cheap `reltuples` estimate must be refreshed before it can be
 * trusted — the same asymmetry `reconcileFieldIndexes` documents.
 *
 * Only ONE verdict can be catastrophically wrong from a stale estimate, and it
 * is "small": `reltuples` is maintained by autoanalyze, not by INSERT, so a
 * table that just received 25 000 rows still reads as the empty one it was
 * (measured — every index decision during that import read 55). Here that
 * mistake means embedding the whole import, which is exactly the spend this
 * ceiling exists to avoid. "Big" needs no second opinion: an estimate only
 * lags upward, so a table Postgres already believes is big really is.
 */
export const needsFreshEstimate = (input: {
  preference: boolean | null;
  rows: number;
}): boolean => input.preference === null && input.rows < CARD_INDEX_ROW_CEILING;

/**
 * Whether this type's records should carry a semantic card. Cached per type for
 * `POLICY_CACHE_TTL_S`, which is what makes the refresh above affordable: one
 * ANALYZE is amortised over the whole wave of card jobs an import produces —
 * including the `false` verdict, which is the one a huge type keeps answering.
 */
export const isCardIndexedType = async (
  collectionId: string,
): Promise<boolean> =>
  selectOrCache(
    () => resolveCardIndexPolicy(collectionId),
    policyCacheKey(collectionId),
    POLICY_CACHE_TTL_S,
  );

const resolveCardIndexPolicy = async (
  collectionId: string,
): Promise<boolean> => {
  const type = await db.query.collections.findFirst({
    columns: { semanticIndex: true },
    where: { id: collectionId },
  });
  const preference = type?.semanticIndex ?? null;
  if (preference !== null) return preference;

  let rows = await estimatedRowCount(collectionId);
  if (needsFreshEstimate({ preference, rows })) {
    await analyzeCollectionTable(collectionId);
    rows = await estimatedRowCount(collectionId);
  }
  return cardIndexVerdict({ preference, rows });
};

/**
 * Forget a type's cached verdict — after an explicit preference change, so the
 * new setting takes effect on the next card instead of up to five minutes later.
 */
export const forgetCardIndexPolicy = async (
  collectionId: string,
): Promise<void> => {
  await redis.del(policyCacheKey(collectionId));
};

/**
 * Drop every semantic card of one type. Idempotent, and a no-op once the type
 * has been reconciled — which is what lets the maintenance sweep call it on
 * every pass without a "already purged" stamp.
 *
 * Served by the GIN index on `metadata`: `collection_id` appears only in
 * record metadata, so the containment probe lands on this type's cards alone.
 * Returns how many vectors were removed.
 *
 * Takes an optional `tx` because deleting a TYPE must purge its cards in the
 * same transaction that drops it: the records vanish by FK cascade, which emits
 * no `record.deleted` and therefore triggers no per-card cleanup.
 */
export const purgeCardVectorsForType = async (input: {
  collectionId: string;
  tx?: Transaction;
}): Promise<number> => {
  const result = await (input.tx ?? db).execute(
    sql`DELETE FROM ${aiVectors}
        WHERE ${aiVectors.sourceType} = 'records'
          AND ${aiVectors.metadata} @> ${JSON.stringify({ collection_id: input.collectionId })}::jsonb`,
  );
  return result.rowCount ?? 0;
};

/**
 * Drop record cards whose record no longer exists — the safety net under the
 * per-type purge above.
 *
 * A card is only ever written for a live record, so a `source_id` with no
 * `collection_records` row is unambiguously dead weight. It is not harmless: an
 * orphan keeps competing in every semantic sweep, and it lets the agent RETRIEVE
 * data the user deleted. Measured on a development database before the type
 * delete path was fixed: 14 545 of 14 607 record vectors were orphans, all from
 * one deleted type, drowning a corpus that held 33 document chunks.
 *
 * Kept as a periodic pass rather than trusted to the write paths alone, because
 * the write paths cannot cover every way a record disappears (a restored dump,
 * a maintenance script, a crash between commit and cleanup).
 */
export const purgeOrphanRecordVectors = async (): Promise<number> => {
  const result = await db.execute(
    sql`DELETE FROM ${aiVectors} v
        WHERE v.source_type = 'records'
          AND NOT EXISTS (
            SELECT 1 FROM collection_records r WHERE r.id = v.source_id
          )`,
  );
  return result.rowCount ?? 0;
};

/**
 * Bring one type's cards in line with the policy — the reconciliation half.
 *
 * The gate in `buildRecordCard` only decides what happens NEXT, so a type that
 * crosses the ceiling mid-import keeps whatever cards were written before the
 * crossing: a few thousand rows of a 200 000-row type, indexed by nothing more
 * principled than arriving first. That residue is the failure this policy was
 * written against — a subset of a type carrying an extra retrieval arm biases
 * every fused ranking toward it. Sweeping it removes the arbitrariness; the
 * DELETE finds nothing on every later pass.
 */
export const reconcileCardIndexPolicy = async (input: {
  collectionId: string;
}): Promise<number> => {
  if (await isCardIndexedType(input.collectionId)) return 0;
  return purgeCardVectorsForType({ collectionId: input.collectionId });
};
