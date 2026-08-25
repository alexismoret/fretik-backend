import { and, eq, exists, notExists, or, sql, type SQL } from "drizzle-orm";
import { QueryBuilder, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { AiVectorSourceType } from "../../db/schema";
import {
  aiContextFiles,
  aiEpisodes,
  aiMemories,
  aiVectors,
  documents,
  pages,
  workflows,
} from "../../db/schema";

/**
 * Reconciliation of `ai_vectors` against the rows it indexes.
 *
 * Every write path that maintains a vector is fire-and-forget: a failed index
 * must never roll back the save it accompanies, so the refreshers log and
 * swallow. That is a deliberate trade, and it is only sound with something
 * that notices what got dropped — otherwise "self-heals on the next save"
 * quietly means "stays wrong until somebody happens to save it again".
 *
 * This is that something. It generalises `purgeOrphanRecordVectors`, whose
 * docstring already made the argument for the records case: the write paths
 * "cannot cover every way a record disappears (a restored dump, a maintenance
 * script, a crash between commit and cleanup)".
 *
 * Detection lives here and is read-mostly; deciding what to do about a
 * finding, capping the work and calling the refreshers belongs to the worker
 * in `@fretik/jobs`, which is also the only place allowed to reach the AI
 * service.
 *
 * Drift is measured with `updated_at`, which every parent table and
 * `ai_vectors` itself already carry — no `content_hash` needed anywhere. For
 * that to mean anything, a vectoriser that SKIPS a re-embed (the card is
 * unchanged) must still touch `ai_vectors.updated_at`, so the column reads as
 * "last verified" rather than "last rewritten".
 */

interface SourceDescriptor {
  table: PgTable;
  id: PgColumn;
  updatedAt: PgColumn;
  /**
   * What makes a parent row one that SHOULD have vectors right now.
   * Drives the missing/stale detectors — "this ought to be indexed and isn't".
   */
  indexable?: SQL;
  /**
   * What makes a parent row one whose vectors must be REMOVED even though the
   * row itself is still there — archived, demoted, withdrawn.
   *
   * Deliberately not the negation of `indexable`: "not indexable yet" and
   * "no longer indexable" are different states with opposite remedies. A
   * document mid-reprocessing is not `ready`, so it is not indexable — but
   * deleting its vectors would strip it from search until the new ones land.
   * It waits; an archived workflow does not.
   */
  retired?: SQL;
  /**
   * Whether a parent with no vectors is a defect. False where "no vectors" is
   * frequently the correct state and another pass already owns that decision.
   */
  detectMissing: boolean;
}

/**
 * `skills` is absent on purpose: its rows are global, keyed by a
 * `(name, file)` tuple rather than a parent row id, and the boot indexer
 * already diffs them against the bundled set.
 */
const SOURCES: Partial<Record<AiVectorSourceType, SourceDescriptor>> = {
  pages: {
    table: pages,
    id: pages.id,
    updatedAt: pages.updatedAt,
    detectMissing: true,
  },
  workflows: {
    table: workflows,
    id: workflows.id,
    updatedAt: workflows.updatedAt,
    indexable: sql`${workflows.status} <> 'archived'`,
    // Archiving is what `deactivate` already drops the card for; the sweep
    // catches the ones it missed.
    retired: sql`${workflows.status} = 'archived'`,
    detectMissing: true,
  },
  memories: {
    table: aiMemories,
    id: aiMemories.id,
    updatedAt: aiMemories.updatedAt,
    detectMissing: true,
  },
  context: {
    table: aiContextFiles,
    id: aiContextFiles.id,
    updatedAt: aiContextFiles.updatedAt,
    // No `retired`: `uploading`/`extracting` are on the way to ready, and a
    // failed extraction never produced vectors to remove.
    indexable: sql`${aiContextFiles.status} = 'ready'`,
    detectMissing: true,
  },
  episodes: {
    table: aiEpisodes,
    id: aiEpisodes.id,
    updatedAt: aiEpisodes.updatedAt,
    indexable: sql`${aiEpisodes.state} = 'active'`,
    // Demotion and supersession are exactly "leaves recall, keeps the row".
    retired: sql`${aiEpisodes.state} <> 'active'`,
    detectMissing: true,
  },
  documents: {
    table: documents,
    id: documents.id,
    updatedAt: documents.updatedAt,
    // No `retired`: a document being converted or re-processed keeps the
    // vectors it already has until the new ones replace them.
    indexable: sql`${documents.status} = 'ready'`,
    detectMissing: true,
  },
};

/*
 * `records` is absent too, and deliberately.
 *
 * Whether a record deserves a card is a policy decision — `CARD_INDEX_ROW_CEILING`,
 * the per-collection `semanticIndex` preference — that `reconcileCardIndexPolicy`
 * already owns, and `purgeOrphanRecordVectors` already drops its orphans nightly
 * on the collection-index sweep. Adding records here would duplicate that purge
 * and pit a generic missing-vector detector against the policy every night, for
 * the one type whose cards this sweep could not rebuild anyway.
 */

export const RECONCILABLE_SOURCE_TYPES = Object.keys(
  SOURCES,
) as AiVectorSourceType[];

/**
 * How far behind its parent a vector may be before it counts as stale.
 *
 * Wider than any legitimate async refresh window, so an ordinary save — write
 * the row, re-index a moment later — never registers as drift.
 */
export const DEFAULT_STALE_SLACK_MS = 5 * 60 * 1000;

export const descriptorFor = (
  sourceType: AiVectorSourceType,
): SourceDescriptor => {
  const descriptor = SOURCES[sourceType];
  if (!descriptor) {
    throw new Error(
      `No reconciliation descriptor for source type ${sourceType}`,
    );
  }
  return descriptor;
};

/**
 * Vectors that must go: the parent row is gone, or it is still there but
 * retired. Both are "this must stop being findable"; a parent that is merely
 * not indexable YET is neither, and is left alone.
 */
/**
 * Subquery builder that needs no connection — this module must stay loadable
 * without a database so the predicate tests can render its SQL, and so a test
 * file importing it never drags the real `db` into the shared bun process and
 * poisons the module cache for files that mock it.
 */
const qb = new QueryBuilder();

const vectorIsOrphaned = (descriptor: SourceDescriptor): SQL => {
  const parentGone = notExists(
    qb
      .select({ one: sql`1` })
      .from(descriptor.table)
      .where(eq(descriptor.id, aiVectors.sourceId)),
  ).getSQL();
  if (!descriptor.retired) return parentGone;
  const parentRetired = exists(
    qb
      .select({ one: sql`1` })
      .from(descriptor.table)
      .where(and(eq(descriptor.id, aiVectors.sourceId), descriptor.retired)),
  ).getSQL();
  return or(parentGone, parentRetired) as SQL;
};

/** `WHERE NOT EXISTS (a vector for this parent)`. */
export const missingVector = (
  sourceType: AiVectorSourceType,
  descriptor: SourceDescriptor,
): SQL =>
  notExists(
    qb
      .select({ one: sql`1` })
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, sourceType),
          // Both sides are uuid — never cast either to text. A `::text` here
          // is what silently broke the workflow backfill: Postgres refuses the
          // whole query with "no operator matches uuid = text".
          eq(aiVectors.sourceId, descriptor.id),
        ),
      ),
  ).getSQL();

/**
 * The orphan predicate for one source type, as a standalone condition.
 *
 * Exported so a unit test can assert the generated SQL names the RIGHT parent
 * table and column per source type. That is the real failure mode here — a
 * descriptor pointing at the wrong table would mark an entire type orphaned —
 * and it is a coding error, so it is caught deterministically in CI rather
 * than guessed at from row counts at 01:00.
 *
 * A runtime "refuse if too many look orphaned" guard was considered and
 * rejected: it protects least where the absolute numbers are largest, and it
 * would block the LEGITIMATE mass purges (a team deleting a big collection, a
 * customer offboarding) that matter most — an orphan is a deleted document
 * still answering searches, so delaying its removal is the unsafe direction.
 */
export const orphanCondition = (sourceType: AiVectorSourceType): SQL =>
  and(
    eq(aiVectors.sourceType, sourceType),
    vectorIsOrphaned(descriptorFor(sourceType)),
  ) as SQL;
