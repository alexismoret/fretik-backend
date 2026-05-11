import db from "@fretik/shared/db";
import type {
  AiVectorMetadata,
  AiVectorSourceType,
} from "@fretik/shared/db/schema";
import { aiVectors } from "@fretik/shared/db/schema";
import { and, eq } from "drizzle-orm";
import { EMBEDDING_DIMENSIONS } from "../../lib/embeddings";
import type { EnrichedChunk } from "./contextual-enrichment";

/*
 * Note on halfvec serialisation: drizzle-orm types the `halfvec` column as
 * `number[]` on insert and handles the pgvector text-literal conversion
 * internally. We pass the raw fp32 array and Postgres implicitly narrows
 * to fp16 at insert time on the `halfvec(2560)` column.
 */

/**
 * Bulk upsert of vectorised chunks for a single source.
 *
 * Semantics (idempotent re-vectorisation):
 *   1. DELETE every existing row for `(sourceType, sourceId)` — keyed
 *      by the composite btree index `idx_ai_vectors_source`.
 *   2. INSERT the new chunks in one batch.
 *
 * Performed inside a single transaction so a partial failure never
 * leaves the table with half the old chunks + half the new ones.
 *
 * Column layout (see `ai-vectors.ts`):
 *   - `content`, `contextualPrefix`, `chunkIndex`, `totalChunks` are
 *     written from the enriched chunk directly.
 *   - `embedding` is passed as a raw fp32 `number[]`; drizzle-orm's
 *     `halfvec` column serialises it to the pgvector text literal and
 *     Postgres implicitly narrows to fp16 on the `halfvec(2560)`
 *     column type — no client-side conversion is required.
 *   - `sourceType`, `sourceId`, `teamId`, `organizationId` are plain
 *     columns (the universal fields moved out of the metadata JSONB in
 *     the Phase 7a.1 refactor — faster filter queries, no duplication).
 *   - `metadata` only carries source-specific fields now.
 *   - `search_vector` is GENERATED STORED and is populated by Postgres
 *     on INSERT — **never** written from the client.
 *
 * Defensive filter: any chunk whose embedding is null or whose length
 * is not exactly `EMBEDDING_DIMENSIONS` is dropped before the insert
 * so a single bad vector can't blow up the whole source's ingestion.
 */

export interface VectorizedChunkInput {
  chunk: EnrichedChunk;
  embedding: number[];
}

export interface UpsertInput {
  sourceType: AiVectorSourceType;
  sourceId: string;
  /**
   * Tenant scope. Both NULL together for global sources (currently
   * skills only); both set for every other source kind. The DB-level
   * `ai_vectors_scope_consistency` CHECK constraint enforces the
   * (both-or-neither) invariant.
   */
  teamId: string | null;
  organizationId: string | null;
  /**
   * User-scope discriminator for sources that can be either team-shared
   * (NULL — documents, skills, team memories, team context) or owned
   * by an individual user (UUID — user memories, user context).
   * Powers the `(team_id, user_id) WHERE source_type IN ('memories','context')`
   * partial index for fast scope prefiltering before the HNSW scan.
   */
  userId?: string | null;
  metadata: AiVectorMetadata;
  chunks: VectorizedChunkInput[];
}

export interface UpsertResult {
  /** Number of rows successfully inserted. */
  rowsInserted: number;
  /** Number of chunks dropped because their embedding was invalid. */
  rowsDropped: number;
}

export const upsertVectors = async ({
  sourceType,
  sourceId,
  teamId,
  organizationId,
  userId = null,
  metadata,
  chunks,
}: UpsertInput): Promise<UpsertResult> => {
  const valid: VectorizedChunkInput[] = [];
  let rowsDropped = 0;
  for (const c of chunks) {
    if (
      Array.isArray(c.embedding) &&
      c.embedding.length === EMBEDDING_DIMENSIONS
    ) {
      valid.push(c);
    } else {
      rowsDropped++;
    }
  }

  if (valid.length === 0) {
    // Still wipe the old rows so stale vectors don't linger when a
    // source is re-ingested with zero valid chunks (edge case — empty
    // doc, all-failed embeddings). The transaction wrapper below is
    // overkill for a single DELETE but keeps the semantics uniform.
    await db
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, sourceType),
          eq(aiVectors.sourceId, sourceId),
        ),
      );
    return { rowsInserted: 0, rowsDropped };
  }

  const rows = valid.map((c) => ({
    content: c.chunk.content,
    contextualPrefix: c.chunk.contextualPrefix,
    chunkIndex: c.chunk.index,
    totalChunks: c.chunk.totalChunks,
    embedding: c.embedding,
    sourceType,
    sourceId,
    teamId,
    organizationId,
    userId,
    metadata,
  }));

  await db.transaction(async (tx) => {
    await tx
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, sourceType),
          eq(aiVectors.sourceId, sourceId),
        ),
      );
    await tx.insert(aiVectors).values(rows);
  });

  return { rowsInserted: rows.length, rowsDropped };
};
