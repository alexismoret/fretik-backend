import { and, eq } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import type { ContextVectorMetadata } from "../../db/schema/ai-vectors";
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
 * Triggers a vector refresh (upsert) for a single context file. Mirrors
 * `services/ai-memory/vector-refresh.ts`: the entire vectorize pipeline
 * (chunk → enrich → embed → upsert) runs inside `@fretik/ai` via the
 * `POST /internal/vectorize` endpoint. The endpoint DELETEs existing
 * vectors for `(source_type='context', source_id=fileId)` before
 * re-inserting, so the call is idempotent — safe to fire on initial
 * extraction and on any later re-run.
 *
 * Bails early when:
 *   - the file row has been deleted between the hook firing and now
 *     (race-safe: a delayed refresh after `delete.ts` would otherwise
 *     re-create orphan vectors that the cascade DELETE just removed),
 *   - the file is not yet in `status='ready'` — `content` would be
 *     NULL and we would have nothing to embed,
 *   - extraction succeeded but produced empty content (defensive: the
 *     vectorizer rejects `content.trim().length === 0` for non-document
 *     sources).
 *
 * Fire-and-forget: errors are logged, never thrown. The aiContextFiles
 * row is the source of truth — failing to vectorise must not roll back
 * the user-visible status flip.
 */
export const triggerContextVectorRefresh = async (
  fileId: string,
): Promise<void> => {
  try {
    const file = await db.query.aiContextFiles.findFirst({
      where: { id: fileId },
    });

    if (!file) {
      // Row was deleted between the upload hook firing and now —
      // nothing to re-vectorise. The cascade DELETE in
      // `deleteContextVectors` (or the `delete.ts` hook) has already
      // cleared any pre-existing vectors, so this branch is silent.
      return;
    }
    if (file.status !== "ready") {
      // Extraction failed (status='error') or is still mid-flight
      // (status='extracting' / 'uploading'). Either way: nothing
      // useful to embed. The hook only fires after the success update
      // in upload.ts, so this branch is rare but defensive.
      return;
    }
    if (!file.content || file.content.trim().length === 0) {
      // Empty extraction (e.g. an image OCR that produced no text).
      // Skip silently — the row stays queryable in the settings UI
      // but nothing for retrieval to surface.
      return;
    }

    const profile = await db.query.aiContextProfiles.findFirst({
      where: { id: file.profileId },
    });
    if (!profile) {
      console.warn(
        `[ContextVectorRefresh] Parent profile ${file.profileId} missing for file ${fileId} — skipping vectorise`,
      );
      return;
    }

    const metadata: ContextVectorMetadata = {
      scope: profile.scope,
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.size,
      profile_id: profile.id,
      created_at: file.createdAt.toISOString(),
      updated_at: file.updatedAt.toISOString(),
    };

    // For team-scope profiles `userId` stays NULL (every team member
    // reads). For user-scope profiles the parent's `userId` is the
    // owner — guaranteed non-null by `ai_context_profiles_scope_check`.
    const userId = profile.scope === "user" ? profile.userId : null;

    // The internal middleware needs a UUID-shaped `X-Context-Team-Id`
    // header even though `/internal/vectorize` reads the truthful
    // value from the body. For user-scope profiles `profile.teamId`
    // is NULL — we fall back to `organizationId` so the header is a
    // valid UUID; the body still carries `teamId: null` and lands
    // that NULL on `ai_vectors.team_id`.
    const result = await callAiService(
      "/internal/vectorize",
      {
        sourceType: "context",
        sourceId: file.id,
        content: file.content,
        metadata,
        teamId: profile.teamId,
        organizationId: profile.organizationId,
        userId,
      },
      aiVectorizeResponseSchema,
      {
        teamId: profile.teamId ?? profile.organizationId,
        organizationId: profile.organizationId,
      },
    );

    if (!result.success) {
      console.warn(
        `[ContextVectorRefresh] AI service returned success=false for file ${fileId}`,
      );
    }
  } catch (error) {
    console.error(`[ContextVectorRefresh] Failed for file ${fileId}:`, error);
  }
};

/**
 * Removes all vector rows for a deleted context file. Called from
 * `deleteContextFile` AFTER the parent row is gone (vectors don't have
 * a direct FK to `ai_context_files` — `source_id` is a plain string —
 * so the cascade FK chain doesn't reach them). Direct SQL DELETE
 * bypasses the AI service: there is nothing to embed and the
 * round-trip would only add latency to the user-visible delete.
 *
 * Fire-and-forget: same contract as `triggerContextVectorRefresh`.
 */
export const deleteContextVectors = async (fileId: string): Promise<void> => {
  try {
    await db
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "context"),
          eq(aiVectors.sourceId, fileId),
        ),
      );
  } catch (error) {
    console.error(
      `[ContextVectorRefresh] Failed to delete vectors for file ${fileId}:`,
      error,
    );
  }
};
