import { eq, sql } from "drizzle-orm";
import db from "../../db";
import {
  documentEntities,
  documentLabels,
  documentProperties,
  documents,
  folders,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { deleteKeysByPrefix } from "../../lib/redis";
import type { UpdateDocumentInput } from "../../schemas/documents";
import { setDocumentFieldValues } from "./field-values";
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

    if (updates.entities !== undefined) {
      await tx
        .delete(documentEntities)
        .where(eq(documentEntities.documentId, id));
      if (updates.entities.length > 0) {
        await tx.insert(documentEntities).values(
          updates.entities.map((e) => ({
            documentId: id,
            entityId: e.entityId,
            role: e.role,
            source: "user_manual" as const,
          })),
        );
      }
    }

    // Dynamic field values keyed by definition slug. `null` clears a key
    // for this document; absence leaves it untouched (the caller sends
    // only the fields the user actually changed).
    if (updates.fieldValues !== undefined) {
      await setDocumentFieldValues({
        documentId: id,
        teamId,
        values: updates.fieldValues,
        source: "user_manual",
        tx,
      });
    }

    await deleteKeysByPrefix(`document:${id}`);

    return doc;
  });

  triggerDocumentVectorRefresh(id, teamId, organizationId).catch(() => {});

  return updatedDoc;
};
