import { eq } from "drizzle-orm";
import db from "../../db";
import { entities } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteFilesFromS3 } from "../../lib/s3";

/**
 * Deletes an entity, its S3 image, and all its document links (cascade).
 */
export const deleteEntity = async (data: { id: string; teamId: string }) => {
  const existing = await db.query.entities.findFirst({
    columns: { id: true, imageS3Key: true },
    where: { id: data.id, teamId: data.teamId },
  });

  if (!existing) {
    return throwHttpError(404, notFound("Entity not found"));
  }

  // Delete S3 image if it exists
  if (existing.imageS3Key) {
    await deleteFilesFromS3([existing.imageS3Key]);
  }

  return db.delete(entities).where(eq(entities.id, data.id));
};
