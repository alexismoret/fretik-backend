import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import { aiVectors, folders, teamSettings } from "../../db/schema";
import { documents } from "../../db/schema/documents";
import {
  buildDocumentOriginalKey,
  buildDocumentSidecarKey,
  buildDocumentThumbnailKey,
} from "../../lib/document-storage";
import { deleteFilesFromS3 } from "../../lib/s3";

/**
 * Deletes multiple documents and updates parent folder counts.
 * Handles both database deletion and S3 file cleanup.
 */
export const deleteDocuments = async (data: {
  ids: string[];
  teamId: string;
}) => {
  const { ids, teamId } = data;

  const existingDocuments = await db.query.documents.findMany({
    columns: {
      id: true,
      folderId: true,
      originalFilename: true,
      status: true,
      fileSize: true,
    },
    where: { id: { in: ids }, teamId },
  });

  // Prepare to decrement parent's documentCount
  const folderIdsCountMap: Record<string, number> = {};
  const folderIdsToUpdate = existingDocuments
    .map((f) => f.folderId)
    .filter((folderId) => folderId !== null);

  folderIdsToUpdate.forEach((x) => {
    folderIdsCountMap[x] = (folderIdsCountMap[x] || 0) + 1;
  });

  // Calculate total storage to free
  const totalFileSize = existingDocuments.reduce(
    (acc, doc) => acc + doc.fileSize,
    0,
  );
  const totalGo = totalFileSize / 1024 ** 3;

  const res = await db.transaction(async (tx) => {
    // Decrement parent's documentCount. Sequential, NOT Promise.all: a
    // transaction holds a single pg connection, so concurrent queries on `tx`
    // serialize on one client and trip pg's "client is already executing a
    // query" deprecation (a hard error in pg@9).
    for (const [id, count] of Object.entries(folderIdsCountMap)) {
      await tx
        .update(folders)
        .set({ documentCount: sql`${folders.documentCount} - ${count}` })
        .where(eq(folders.id, id));
    }

    // Decrement storageUsedGb
    if (totalGo > 0) {
      await tx
        .update(teamSettings)
        .set({
          storageUsedGb: sql`GREATEST(0, ${teamSettings.storageUsedGb} - ${totalGo})`,
        })
        .where(eq(teamSettings.teamId, teamId));
    }

    // Delete documents
    const deleteRes = await tx
      .delete(documents)
      .where(inArray(documents.id, ids));

    // Delete vectors
    await tx
      .delete(aiVectors)
      .where(
        and(
          inArray(aiVectors.sourceId, ids),
          eq(aiVectors.sourceType, "documents"),
          eq(aiVectors.teamId, teamId),
        ),
      );

    // Delete files in S3 — binary, thumbnail, and OCR markdown sidecar.
    // Sidecars only exist for non-spreadsheet documents; `deleteFilesFromS3`
    // (via `deleteObjects`) treats missing keys as success, so it's safe to
    // include every doc's sidecar key unconditionally.
    await deleteFilesFromS3([
      ...new Set(
        existingDocuments
          .filter((d) => d.status !== "uploading")
          .flatMap((d) => [
            buildDocumentOriginalKey(d.id, d.originalFilename),
            buildDocumentThumbnailKey(d.id),
            buildDocumentSidecarKey(d.id),
          ]),
      ),
    ]);

    return deleteRes;
  });

  return res;
};
