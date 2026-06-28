import { eq, sql } from "drizzle-orm";
import db from "../../db";
import {
  documentLabels,
  documentProperties,
  documents,
  folders,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteKeysByPrefix } from "../../lib/redis";
import type { UpdateDocumentInput } from "../../schemas/documents";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { setRecordData } from "../object-records/update";
import { readRecordData } from "../object-schema/record-io";
import { triggerDocumentVectorRefresh } from "./vector-refresh";

/**
 * Update a document and its associated data.
 * Handles folder changes (counts), universal property edits (summary,
 * language), label assignments, entity links and dynamic field values
 * (per-team configured fields).
 */
export const updateDocument = async (data: {
  id: string;
  teamId: string;
  organizationId: string;
  updates: UpdateDocumentInput;
}) => {
  const { id, teamId, organizationId, updates } = data;

  const existingDocument = await db.query.documents.findFirst({
    columns: { id: true, folderId: true },
    where: { id, teamId },
  });
  if (!existingDocument) {
    return throwHttpError(404, notFound());
  }

  const folderHasChanged = existingDocument.folderId !== updates.folderId;

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
        originalFilename: updates.originalFilename,
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

    // Reset labels when an explicit list is provided.
    if (updates.labelIds !== undefined) {
      await tx.delete(documentLabels).where(eq(documentLabels.documentId, id));
      if (updates.labelIds.length > 0) {
        await tx.insert(documentLabels).values(
          updates.labelIds.map((labelId) => ({
            documentId: id,
            labelId,
          })),
        );
      }
    }

    // Field values live on the document's 1:1 mirror record. Merge the partial
    // patch into its `data` — `null` clears a key, absence leaves it untouched
    // (the caller sends only the fields the user changed). Editing the set of
    // linked records (the former `entities`) moves to the generic object editor.
    if (updates.fieldValues !== undefined) {
      const mirror = await tx.query.objectRecords.findFirst({
        columns: { id: true, objectTypeId: true, teamId: true },
        where: { documentId: id },
      });
      if (mirror) {
        const current = await readRecordData({
          tx,
          objectTypeId: mirror.objectTypeId,
          recordId: mirror.id,
          fields: await getFieldDefinitionsForTeam({
            teamId: mirror.teamId,
            objectTypeId: mirror.objectTypeId,
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
