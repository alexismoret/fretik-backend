import { and, eq, inArray, sql } from "drizzle-orm";
import { driveVisibility } from "../../authz/drive-sql";
import { SYSTEM } from "../../authz/system-principals";
import db from "../../db";
import { aiVectors, folders, teamSettings } from "../../db/schema";
import { documents } from "../../db/schema/documents";
import {
  buildDocumentOriginalKey,
  buildDocumentPreviewPdfKey,
  buildDocumentSidecarKey,
  buildDocumentThumbnailKey,
} from "../../lib/document-storage";
import { deleteFilesFromS3 } from "../../lib/s3";
import { bulkDeleteCollectionRecords } from "../collection-records/bulk-delete";
import { resolveDocumentRecordIds } from "../collection-records/resolve-document-record";

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
      fileHash: true,
    },
    where: { id: { in: ids }, teamId },
  });
  // Every statement below works on THESE ids — the ones the team owns — and
  // never on the caller's list. An id of another team is skipped, exactly as
  // if it did not exist: the pre-read above is the authorization, so a write
  // that went back to `ids` would delete whatever the caller named.
  const ownedIds = existingDocuments.map((d) => d.id);

  // Prepare to decrement parent's documentCount
  const folderIdsCountMap: Record<string, number> = {};
  const folderIdsToUpdate = existingDocuments
    .map((f) => f.folderId)
    .filter((folderId) => folderId !== null);

  folderIdsToUpdate.forEach((x) => {
    folderIdsCountMap[x] = (folderIdsCountMap[x] || 0) + 1;
  });

  // Superseded versions are real objects alongside the live original, so they
  // are freed and refunded too. Read them BEFORE the delete: the FK is
  // `ON DELETE SET NULL` (the rows outlive the document as an audit trail), so
  // afterwards they are no longer reachable by `documentId`. An archive is any
  // version not pointing at its document's live original key — that one is
  // already accounted for by `documents.fileSize`.
  const versionRows =
    ownedIds.length > 0
      ? await db.query.documentVersions.findMany({
          columns: {
            documentId: true,
            storageKey: true,
            fileSize: true,
            fileHash: true,
          },
          where: { documentId: { in: ownedIds }, teamId },
        })
      : [];
  const originalKeyById = new Map(
    existingDocuments.map((d) => [
      d.id,
      buildDocumentOriginalKey(d.id, d.originalFilename),
    ]),
  );
  const archives = versionRows.filter(
    (v) =>
      v.documentId !== null &&
      v.storageKey !== originalKeyById.get(v.documentId),
  );

  // Calculate total storage to free
  const totalFileSize =
    existingDocuments.reduce((acc, doc) => acc + doc.fileSize, 0) +
    archives.reduce((acc, v) => acc + v.fileSize, 0);
  const totalGo = totalFileSize / 1024 ** 3;

  const res = await db.transaction(async (tx) => {
    // Remove each file's 1:1 graph mirror (and, by FK cascade, its `mentions`
    // links + typed row) BEFORE the `documents` rows go — otherwise the mirror's
    // `document_id` FK nulls (ON DELETE SET NULL) and the record survives as a
    // fileless "Document" orphan. Same tx, so both commit or neither does.
    const mirrorIds = [
      ...(
        await resolveDocumentRecordIds({
          documentIds: ownedIds,
          teamId,
          // Every file going takes its mirror with it, seen or not.
          drive: await driveVisibility(SYSTEM.documentPipeline, teamId),
          tx,
        })
      ).values(),
    ];
    if (mirrorIds.length > 0) {
      await bulkDeleteCollectionRecords({ teamId, ids: mirrorIds, tx });
    }

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
      .where(
        and(inArray(documents.id, ownedIds), eq(documents.teamId, teamId)),
      );

    // Delete vectors
    await tx
      .delete(aiVectors)
      .where(
        and(
          inArray(aiVectors.sourceId, ownedIds),
          eq(aiVectors.sourceType, "documents"),
          eq(aiVectors.teamId, teamId),
        ),
      );

    // Delete files in S3 — binary, thumbnail, OCR markdown sidecar, and
    // every PDF rendition the document ever had.
    // Sidecars only exist for non-spreadsheet documents; `deleteFilesFromS3`
    // (via `deleteObjects`) treats missing keys as success, so it's safe to
    // include every doc's sidecar key unconditionally.
    //
    // Renditions are addressed by hash, so the keys are derived from every
    // hash this document is known to have held: its current one, plus each
    // version's. That covers the renditions of superseded bytes without a
    // LIST per document — and a bulk delete of a folder would otherwise pay
    // one round trip per file to find objects most documents never had.
    const renditionKeys = [
      ...existingDocuments.map((d) =>
        buildDocumentPreviewPdfKey(d.id, d.fileHash),
      ),
      ...versionRows.flatMap((v) =>
        v.documentId === null
          ? []
          : [buildDocumentPreviewPdfKey(v.documentId, v.fileHash)],
      ),
    ];

    await deleteFilesFromS3([
      ...new Set([
        // Every document, `uploading` ones included. Their row is being
        // deleted either way, and `uploadDocument` writes the bytes BEFORE
        // it inserts the row — so skipping them did not protect an upload in
        // flight, it stranded the object that upload had already written.
        // A key that was never written deletes as a no-op.
        ...existingDocuments.flatMap((d) => [
          buildDocumentOriginalKey(d.id, d.originalFilename),
          buildDocumentThumbnailKey(d.id),
          buildDocumentSidecarKey(d.id),
        ]),
        ...archives.map((v) => v.storageKey),
        ...renditionKeys,
      ]),
    ]);

    return deleteRes;
  });

  return res;
};
