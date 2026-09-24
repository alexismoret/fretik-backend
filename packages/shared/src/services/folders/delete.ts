import { and, eq, inArray, ne, sql } from "drizzle-orm";
import db from "../../db";
import { aiVectors, documents, folders, teamSettings } from "../../db/schema";
import {
  buildDocumentOriginalKey,
  buildDocumentPreviewPdfKey,
  buildDocumentSidecarKey,
  buildDocumentThumbnailKey,
} from "../../lib/document-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteFilesFromS3 } from "../../lib/s3";
import { bulkDeleteCollectionRecords } from "../collection-records/bulk-delete";
import { resolveDocumentRecordIds } from "../collection-records/resolve-document-record";
import { type EventActor, SYSTEM_ACTOR } from "../domain-events/emit";
import { emitDomainEventsBulk } from "../domain-events/emit-bulk";
import { listFolderSubtreeIds } from "./subtree";

/**
 * Deletes multiple folders and updates parent folder counts.
 */
export const deleteFolders = async (data: {
  ids: string[];
  teamId: string;
  actor?: EventActor;
}) => {
  const { ids, teamId } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;

  const existingFolders = await db.query.folders.findMany({
    columns: { id: true, name: true, parentFolderId: true },
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

    // The folders the delete removes: these, and every folder below them
    // (the parent FK cascades). Walked by parent pointer inside the team —
    // see `listFolderSubtreeIds` for why the path string cannot be used.
    const subtreeIds = await listFolderSubtreeIds({
      rootIds: ids,
      teamId,
      executor: tx,
    });

    // A document of ANOTHER team filed in one of these folders is not ours
    // to delete. `assertFolderInTeam` now refuses to create one, but rows
    // written before it existed may still point here, and the cascade below
    // would take them with the folder. Move them to their own drive root
    // instead: the least surprising place for a file whose folder vanished.
    await tx
      .update(documents)
      .set({ folderId: null })
      .where(
        and(
          inArray(documents.folderId, subtreeIds),
          ne(documents.teamId, teamId),
        ),
      );

    // Every document of the team in these folders and their subfolders.
    //
    // No `status` filter: the folder delete cascades the rows away whatever
    // their status, so excluding `uploading` ones did not spare them — it
    // only stranded their bytes, with the row that named them gone.
    const documentsToDelete = await tx.query.documents.findMany({
      columns: {
        id: true,
        originalFilename: true,
        fileSize: true,
        fileHash: true,
      },
      where: { teamId, folderId: { in: subtreeIds } },
    });

    // Superseded versions are real objects beside the live original, so they
    // are freed and refunded too — the same accounting `deleteDocuments` does.
    // Read BEFORE the cascade: `document_versions.document_id` is ON DELETE SET
    // NULL, so once the folder goes these rows no longer name their document
    // and the archive keys become unreachable from the database.
    const documentIds = documentsToDelete.map((d) => d.id);
    const versionRows =
      documentIds.length > 0
        ? await tx.query.documentVersions.findMany({
            columns: {
              documentId: true,
              storageKey: true,
              fileSize: true,
              fileHash: true,
            },
            where: { documentId: { in: documentIds }, teamId },
          })
        : [];

    const originalKeyById = new Map(
      documentsToDelete.map((d) => [
        d.id,
        buildDocumentOriginalKey(d.id, d.originalFilename),
      ]),
    );
    const archives = versionRows.filter(
      (v) =>
        v.documentId !== null &&
        v.storageKey !== originalKeyById.get(v.documentId),
    );

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
      await bulkDeleteCollectionRecords({ teamId, ids: mirrorIds, tx });
    }

    // Journal the folders before the rows vanish — one set-based emit.
    // Folders carry no org column, so resolve the team's org once.
    const teamRow = await tx.query.team.findFirst({
      columns: { organizationId: true },
      where: { id: teamId },
    });
    if (teamRow) {
      await emitDomainEventsBulk({
        tx,
        organizationId: teamRow.organizationId,
        teamId,
        actor,
        events: existingFolders.map((folder) => ({
          type: "folder.deleted",
          subjectType: "folder",
          payload: { folderId: folder.id, name: folder.name },
          dedupKey: `folder.deleted:${folder.id}`,
        })),
      });
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

    // Refund the freed bytes. A folder delete removes documents exactly as
    // `deleteDocuments` does, so it owes the team the same refund — without
    // it `storage_used_gb` only ever climbs, and a team that tidies up by
    // deleting folders ends up permanently over its own usage figure.
    const freedBytes =
      documentsToDelete.reduce((acc, doc) => acc + doc.fileSize, 0) +
      archives.reduce((acc, v) => acc + v.fileSize, 0);
    const freedGb = freedBytes / 1024 ** 3;
    if (freedGb > 0) {
      await tx
        .update(teamSettings)
        .set({
          storageUsedGb: sql`GREATEST(0, ${teamSettings.storageUsedGb} - ${freedGb})`,
        })
        .where(eq(teamSettings.teamId, teamId));
    }

    // Delete files from S3 after successful folder deletion — for every
    // cascade-deleted document: the binary, its thumbnail, its OCR markdown
    // sidecar, every superseded version archive, and every PDF rendition it
    // ever had (addressed by hash, so derived from the document's current
    // hash plus each version's).
    // Sidecars only exist for non-spreadsheet documents but `deleteObjects`
    // treats missing keys as success, so we include every doc's sidecar
    // unconditionally.
    if (documentsToDelete.length > 0) {
      const s3KeysToDelete = [
        ...new Set([
          ...documentsToDelete.flatMap((doc) => [
            buildDocumentOriginalKey(doc.id, doc.originalFilename),
            buildDocumentThumbnailKey(doc.id),
            buildDocumentSidecarKey(doc.id),
            buildDocumentPreviewPdfKey(doc.id, doc.fileHash),
          ]),
          ...archives.map((v) => v.storageKey),
          ...versionRows.flatMap((v) =>
            v.documentId === null
              ? []
              : [buildDocumentPreviewPdfKey(v.documentId, v.fileHash)],
          ),
        ]),
      ];
      await deleteFilesFromS3(s3KeysToDelete);
    }

    return deleteResult;
  });

  return res;
};
