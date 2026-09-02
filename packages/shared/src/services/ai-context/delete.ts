import { eq } from "drizzle-orm";
import db from "../../db";
import { aiContextFiles } from "../../db/schema/ai-context";
import { deleteContextSidecar } from "../../lib/ai-context-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteObject } from "../../lib/s3";
import { requireOwnedProfileId, type ScopeKey } from "./retrieve";
import { deleteContextVectors } from "./vector-refresh";

/**
 * Delete a context file: removes the S3 original, the optional `.md`
 * sidecar (when `hasMarkdown` is true), and the DB row. S3 deletes
 * are best-effort — a lingering orphaned key is harmless and can be
 * reaped by a janitor job — but we still await them so the
 * conversation hydrator on a concurrent turn doesn't see a stale
 * sidecar after the row is gone.
 */
export const deleteContextFile = async (args: {
  fileId: string;
  scope: ScopeKey;
}): Promise<void> => {
  const file = await db.query.aiContextFiles.findFirst({
    where: {
      id: args.fileId,
      profileId: await requireOwnedProfileId(args.scope),
    },
    columns: {
      id: true,
      profileId: true,
      s3Key: true,
      hasMarkdown: true,
    },
  });
  if (!file) {
    return throwHttpError(404, notFound("Context file not found"));
  }

  await deleteObject(file.s3Key);
  if (file.hasMarkdown) {
    await deleteContextSidecar(file.profileId, file.id);
  }

  await db.delete(aiContextFiles).where(eq(aiContextFiles.id, args.fileId));

  // Fire-and-forget cascade: vectors don't have a direct FK to
  // ai_context_files (source_id is a plain string), so the row delete
  // above doesn't reach them. Errors are logged inside, never thrown.
  void deleteContextVectors(args.fileId);
};
