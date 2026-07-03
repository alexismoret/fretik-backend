import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import { aiVectors, folders } from "../../db/schema";
import {
  buildDocumentOriginalKey,
  buildDocumentSidecarKey,
  buildDocumentThumbnailKey,
} from "../../lib/document-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteFilesFromS3 } from "../../lib/s3";
import { bulkDeleteObjectRecords } from "../object-records/bulk-delete";
import { resolveDocumentRecordIds } from "../object-records/resolve-document-record";

/**
 * Deletes multiple folders and updates parent folder counts.
 */
export const deleteFolders = async (data: {
  ids: string[];
  teamId: string;
}) => {
  const { ids, teamId } = data;

  const existingFolders = await db.query.folders.findMany({
    columns: { id: true, parentFolderId: true, fullPath: true },
    where: { id: { in: ids }, teamId },
  });

  if (existingFolders.length !== ids.length) {
    return throwHttpError(404, notFound());
  }

  // Prepare to decrement parent's subFolderCount
  const parentFolderIdsCountMap: Record<string, number> = {};
  const parentFolderIdsToUpdate = existingFolders
    .map((f) => f.parentFolderId)
    .filter((parentFolderId) => parentFolderId !== null);

  parentFolderIdsToUpdate.forEach((x) => {
    parentFolderIdsCountMap[x] = (parentFolderIdsCountMap[x] || 0) + 1;
  });

  const res = await db.transaction(async (tx) => {
    // Decrement parent's subFolderCount. Sequential, NOT Promise.all: a
    // transaction holds a single pg connection, so concurrent queries on `tx`
    // serialize on one client and trip pg's "client is already executing a
    // query" deprecation (a hard error in pg@9).
    for (const [id, count] of Object.entries(parentFolderIdsCountMap)) {
      await tx
        .update(folders)
        .set({ subFolderCount: sql`${folders.subFolderCount} - ${count}` })
        .where(eq(folders.id, id));
    }

    // Get all documents in the folders and subfolders that are not "uploading"
    const documentsToDelete = await tx.query.documents.findMany({
      columns: { id: true, originalFilename: true },
      where: {
        status: { ne: "uploading" },
        OR: [
          { folderId: { in: ids } },
          ...existingFolders.map((f) => ({
            folder: { fullPath: { like: `${f.fullPath}%` } },
          })),
        ],
      },
    });

    // Delete each doc's 1:1 graph mirror (+ its `mentions` links / typed row via
    // FK cascade) BEFORE the folder delete cascades the documents away —
    // otherwise the mirror's `document_id` FK nulls (ON DELETE SET NULL) and the
    // record survives as a fileless "Document" orphan.
    const mirrorIds = [
      ...(
        await resolveDocumentRecordIds({
          documentIds: documentsToDelete.map((d) => d.id),
          teamId,
          tx,
        })
      ).values(),
    ];
    if (mirrorIds.length > 0) {
      await bulkDeleteObjectRecords({ teamId, ids: mirrorIds, tx });
    }

    // Delete folder (documents will be deleted by cascade)
    const deleteResult = await tx
      .delete(folders)
      .where(inArray(folders.id, ids));

    // Delete vectors
    await tx
      .delete(aiVectors)
      .where(
        and(
          inArray(aiVectors.sourceId, [
            ...new Set(documentsToDelete.map((d) => d.id)),
          ]),
          eq(aiVectors.sourceType, "documents"),
          eq(aiVectors.teamId, teamId),
        ),
      );

    // Delete files from S3 after successful folder deletion — binary,
    // thumbnail, and OCR markdown sidecar for every cascade-deleted doc.
    // Sidecars only exist for non-spreadsheet documents but `deleteObjects`
    // treats missing keys as success, so we include every doc's sidecar
    // unconditionally.
    if (documentsToDelete.length > 0) {
      const s3KeysToDelete = [
        ...new Set(
          documentsToDelete.flatMap((doc) => [
            buildDocumentOriginalKey(doc.id, doc.originalFilename),
            buildDocumentThumbnailKey(doc.id),
            buildDocumentSidecarKey(doc.id),
          ]),
        ),
      ];
      await deleteFilesFromS3(s3KeysToDelete);
    }

    return deleteResult;
  });

  return res;
};
