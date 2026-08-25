import { eq, sql } from "drizzle-orm";
import db from "../../db";
import { documentProperties, documents, folders } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteKeysByPrefix } from "../../lib/redis";
import type { UpdateDocumentInput } from "../../schemas/documents";
import { setRecordData } from "../collection-records/update";
import { readRecordData } from "../collection-schema/record-io";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { triggerDocumentVectorRefresh } from "./vector-refresh";

/**
 * A rename must not change the file's EXTENSION.
 *
 * Every S3 key a document owns is derived from `originalFilename` —
 * `documents/{id}.pdf` for the bytes, `documents/{id}/v2.pdf` for each archived
 * version. Storing "Rapport Q3" over "rapport.pdf" therefore repoints every
 * lookup at `documents/{id}` while the objects stay where they were: the
 * document silently becomes unreadable, undownloadable, and its whole history
 * unreachable. Nothing in the pipeline notices, because nothing re-reads the
 * bytes on a rename.
 *
 * So the extension is APPENDED rather than trusted, and never stripped: a user
 * naming a file "Rapport Q3" means the title, not a conversion. Passing a
 * different extension yields `name.docx.pdf` — clumsy, but honest about what
 * the bytes are, and lossless. Changing an actual format means a new document.
 */
const keepFileExtension = (
  current: string,
  next: string | undefined,
): string | undefined => {
  if (next === undefined) return undefined;
  const dot = current.lastIndexOf(".");
  const extension = dot > 0 ? current.slice(dot) : "";
  if (extension === "") return next;
  return next.toLowerCase().endsWith(extension.toLowerCase())
    ? next
    : `${next}${extension}`;
};

/**
 * Update a document and its associated data.
 * Handles folder changes (counts), universal property edits (summary,
 * language) and dynamic field values (per-team configured fields).
 */
export const updateDocument = async (data: {
  id: string;
  teamId: string;
  organizationId: string;
  updates: UpdateDocumentInput;
}) => {
  const { id, teamId, organizationId, updates } = data;

  const existingDocument = await db.query.documents.findFirst({
    columns: { id: true, folderId: true, originalFilename: true },
    where: { id, teamId },
  });
  if (!existingDocument) {
    return throwHttpError(404, notFound());
  }

  const folderHasChanged = existingDocument.folderId !== updates.folderId;
  const originalFilename = keepFileExtension(
    existingDocument.originalFilename,
    updates.originalFilename,
  );

  const updatedDoc = await db.transaction(async (tx) => {
    if (folderHasChanged) {
      if (existingDocument.folderId) {
        await tx
          .update(folders)
          .set({ documentCount: sql`${folders.documentCount} - 1` })
          .where(eq(folders.id, existingDocument.folderId));
      }

      if (updates.folderId) {
        await tx
          .update(folders)
          .set({ documentCount: sql`${folders.documentCount} + 1` })
          .where(eq(folders.id, updates.folderId));
      }
    }

    const [doc] = await tx
      .update(documents)
      .set({
        originalFilename,
        folderId: updates.folderId,
      })
      .where(eq(documents.id, id))
      .returning();

    // Universal properties (summary + language). Industry-specific fields
    // go through documentFieldValues below.
    if (
      updates.documentSummary !== undefined ||
      updates.documentLanguage !== undefined
    ) {
      await tx
        .update(documentProperties)
        .set({
          documentSummary: updates.documentSummary,
          documentLanguage: updates.documentLanguage,
        })
        .where(eq(documentProperties.documentId, id));
    }

    // Field values live on the document's 1:1 mirror record. Merge the partial
    // patch into its `data` — `null` clears a key, absence leaves it untouched
    // (the caller sends only the fields the user changed). Editing the set of
    // linked records (the former `entities`) moves to the generic object editor.
    if (updates.fieldValues !== undefined) {
      const mirror = await tx.query.collectionRecords.findFirst({
        columns: { id: true, collectionId: true, teamId: true },
        where: { documentId: id },
      });
      if (mirror) {
        const current = await readRecordData({
          tx,
          collectionId: mirror.collectionId,
          recordId: mirror.id,
          fields: await getFieldDefinitionsForTeam({
            teamId: mirror.teamId,
            collectionId: mirror.collectionId,
          }),
        });
        const merged: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(updates.fieldValues)) {
          if (value === null || value === undefined) delete merged[key];
          else merged[key] = value;
        }
        await setRecordData({
          tx,
          id: mirror.id,
          data: merged,
          source: "user_correction",
          strict: false,
        });
      }
    }

    await deleteKeysByPrefix(`document:${id}`);

    return doc;
  });

  triggerDocumentVectorRefresh(id, teamId, organizationId).catch(() => {});

  return updatedDoc;
};
