import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import db from "../../db";
import type { AiVectorSourceType } from "../../db/schema";
import { aiVectors } from "../../db/schema";
import {
  DEFAULT_STALE_SLACK_MS,
  descriptorFor,
  missingVector,
  orphanCondition,
} from "./reconcile-predicates";

/**
 * The executing half of the reconciliation sweep. The predicates it runs live
 * in `./reconcile-predicates`, which is deliberately database-free.
 */

/**
 * Delete vectors whose parent is gone — or is still there but retired.
 *
 * Unbounded on purpose: one statement per type, nothing to drain over several
 * nights. An orphan is a row the search can still return for something that no
 * longer exists, so a backlog is not a queue to work through politely — it is
 * exposure, and it ends tonight.
 */
export const purgeOrphanVectors = async (
  sourceType: AiVectorSourceType,
): Promise<number> => {
  const deleted = await db
    .delete(aiVectors)
    .where(orphanCondition(sourceType))
    .returning({ id: aiVectors.id });
  return deleted.length;
};

/**
 * Live parents carrying no vectors at all — the mirror of the orphan pass.
 *
 * Oldest first, so a straggler that keeps failing is never starved by fresh
 * churn. Bounded by the caller: a backlog is repaired over several nights
 * rather than in one flood.
 */
export const listMissingVectorSources = async (params: {
  sourceType: AiVectorSourceType;
  limit: number;
}): Promise<string[]> => {
  const descriptor = descriptorFor(params.sourceType);
  if (!descriptor.detectMissing) return [];
  const rows = await db
    .select({ id: descriptor.id })
    .from(descriptor.table)
    .where(
      and(missingVector(params.sourceType, descriptor), descriptor.indexable),
    )
    .orderBy(asc(descriptor.updatedAt))
    .limit(params.limit);
  return rows.map((r) => String(r.id));
};

/**
 * Live parents whose vectors are older than the row they describe.
 *
 * Catches the dropped refresh that the orphan and missing passes cannot see:
 * the vectors exist, they just describe a previous version.
 */
export const listStaleVectorSources = async (params: {
  sourceType: AiVectorSourceType;
  limit: number;
  slackMs?: number;
}): Promise<string[]> => {
  const descriptor = descriptorFor(params.sourceType);
  if (!descriptor.detectMissing) return [];
  const slackSeconds = (params.slackMs ?? DEFAULT_STALE_SLACK_MS) / 1000;

  const indexed = db
    .select({
      sourceId: aiVectors.sourceId,
      indexedAt: max(aiVectors.updatedAt).as("indexed_at"),
    })
    .from(aiVectors)
    .where(eq(aiVectors.sourceType, params.sourceType))
    .groupBy(aiVectors.sourceId)
    .as("indexed");

  const rows = await db
    .select({ id: descriptor.id })
    .from(descriptor.table)
    .innerJoin(indexed, eq(indexed.sourceId, descriptor.id))
    .where(
      and(
        gt(
          descriptor.updatedAt,
          sql`${indexed.indexedAt} + make_interval(secs => ${slackSeconds})`,
        ),
        descriptor.indexable,
      ),
    )
    .orderBy(asc(descriptor.updatedAt))
    .limit(params.limit);
  return rows.map((r) => String(r.id));
};
