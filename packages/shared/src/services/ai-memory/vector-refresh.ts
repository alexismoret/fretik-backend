import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import type { MemoryVectorMetadata } from "../../db/schema/ai-vectors";
import { aiVectors } from "../../db/schema/ai-vectors";
import { callAiService } from "../../lib/ai-service";

const aiVectorizeResponseSchema = z.object({
  success: z.boolean(),
  stats: z
    .object({
      chunksProduced: z.number(),
      chunksEnriched: z.number(),
      rowsInserted: z.number(),
      rowsDropped: z.number(),
    })
    .optional(),
});

/**
 * Triggers a vector refresh (upsert) for a single memory file. Mirrors
 * `services/documents/vector-refresh.ts` so the entire vectorize
 * pipeline (chunk → enrich → embed → upsert) runs inside `@fretik/ai`
 * via the `POST /internal/vectorize` endpoint. The endpoint DELETEs
 * existing vectors for `(source_type='memories', source_id=memoryId)`
 * before re-inserting, so the call is idempotent — safe to fire on
 * create, overwrite, and rename.
 *
 * Race-safe against late deletes: if the memory has been removed
 * between the caller queuing this refresh and us actually running it
 * (the hook is fire-and-forget), `findFirst` returns `undefined` and
 * we no-op. Without this check, a delayed refresh after a `delete`
 * hook would re-create orphan vectors that the cascade DELETE just
 * removed.
 *
 * THROWS — this is the variant the reconciliation worker calls, because a job
 * that cannot fail cannot be retried. Mutation paths want
 * `triggerMemoryVectorRefresh` below instead.
 */
export const triggerMemoryVectorRefreshOrThrow = async (
  memoryId: string,
  teamId: string,
  organizationId: string,
): Promise<void> => {
  const memory = await db.query.aiMemories.findFirst({
    where: { id: memoryId },
  });

  if (!memory) {
    // Memory was deleted between the hook firing and now — nothing to
    // re-vectorise. The cascade DELETE in `deleteMemoryVectors` (or
    // the `delete.ts` hook) has already cleared any pre-existing
    // vectors, so this branch is intentionally silent.
    return;
  }

  const metadata: MemoryVectorMetadata = {
    scope: memory.scope,
    path: memory.path,
    size_bytes: memory.sizeBytes,
    created_at: memory.createdAt.toISOString(),
    updated_at: memory.updatedAt.toISOString(),
  };

  const result = await callAiService(
    "/internal/vectorize",
    {
      sourceType: "memories",
      sourceId: memory.id,
      content: memory.content,
      metadata,
      teamId,
      organizationId,
      userId: memory.userId,
    },
    aiVectorizeResponseSchema,
    { teamId, organizationId },
  );

  if (!result.success) {
    throw new Error(`Vectorize returned success=false for memory ${memoryId}`);
  }
};

/**
 * The mutation-path variant: same work, errors logged and swallowed. The
 * memory row is the source of truth — failing to vectorise must not roll back
 * the user-visible memory write.
 */
export const triggerMemoryVectorRefresh = async (
  memoryId: string,
  teamId: string,
  organizationId: string,
): Promise<void> => {
  try {
    await triggerMemoryVectorRefreshOrThrow(memoryId, teamId, organizationId);
  } catch (error) {
    console.error(
      `[MemoryVectorRefresh] Failed for memory ${memoryId}:`,
      error,
    );
  }
};

/**
 * Removes all vector rows for a deleted memory. Called from the
 * `deleteMemory` service AFTER the parent row is gone (the cascade FK
 * on `ai_vectors.user_id` only fires on user delete, not on memory
 * delete — vectors don't have a direct FK to `ai_memories`). Direct
 * SQL DELETE bypasses the AI service: there is nothing to embed and
 * the round-trip would only add latency to the user-visible delete.
 *
 * Fire-and-forget: same contract as `triggerMemoryVectorRefresh`.
 */
export const deleteMemoryVectors = async (memoryId: string): Promise<void> => {
  try {
    await db
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          eq(aiVectors.sourceId, memoryId),
        ),
      );
  } catch (error) {
    console.error(
      `[MemoryVectorRefresh] Failed to delete vectors for memory ${memoryId}:`,
      error,
    );
  }
};

/**
 * Set-based sibling of `deleteMemoryVectors` for a bulk memory wipe — one
 * `inArray` DELETE instead of a query per id. Same fire-and-forget contract.
 */
export const deleteMemoryVectorsBulk = async (
  memoryIds: string[],
): Promise<void> => {
  if (memoryIds.length === 0) return;
  try {
    await db
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          inArray(aiVectors.sourceId, memoryIds),
        ),
      );
  } catch (error) {
    console.error(
      `[MemoryVectorRefresh] Failed to bulk-delete vectors for ${memoryIds.length.toString()} memories:`,
      error,
    );
  }
};
