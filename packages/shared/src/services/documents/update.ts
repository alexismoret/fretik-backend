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
import { triggerDocumentVectorRefresh } from "./vector-refresh";

/**
 * Updates a document and optionally its processing data.
 * Handles folder changes and updates document counts accordingly.
 */
export const updateDocument = async (data: {
  id: string;
  teamId: string;
  organizationId: string;
  updates: UpdateDocumentInput;
}) => {
  const { id, teamId, organizationId, updates } = data;

  // Check if document exists
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
      // Decrement old folder's document count if it exists
      if (existingDocument.folderId) {
        await tx
          .update(folders)
          .set({ documentCount: sql`${folders.documentCount} - 1` })
          .where(eq(folders.id, existingDocument.folderId));
      }

      // Increment new folder's document count if it exists
      if (updates.folderId) {
        await tx
          .update(folders)
          .set({ documentCount: sql`${folders.documentCount} + 1` })
          .where(eq(folders.id, updates.folderId));
      }
    }

    // Update document
    const [doc] = await tx
      .update(documents)
      .set({
        originalFilename: updates.originalFilename,
        folderId: updates.folderId,
      })
      .where(eq(documents.id, id))
      .returning();

    // Update document properties
    const propertiesToUpdate: Partial<typeof documentProperties.$inferInsert> =
      {
        documentSummary: updates.documentSummary,
        documentType: updates.documentType,
        documentLanguage: updates.documentLanguage,
        documentTransportType: updates.documentTransportType,
        documentDate: updates.documentDate,
        documentNumber: updates.documentNumber,
        transportMode: updates.transportMode,
      };

    if (Object.values(propertiesToUpdate).some((v) => v !== undefined)) {
      await tx
        .update(documentProperties)
        .set({
          documentSummary: updates.documentSummary,
          documentType: updates.documentType,
          documentLanguage: updates.documentLanguage,
          documentTransportType: updates.documentTransportType,
          documentDate: updates.documentDate,
          documentNumber: updates.documentNumber,
          transportMode: updates.transportMode,
        })
        .where(eq(documentProperties.documentId, id));
    }

    // Update labels if labelId is provided
    if (updates.labelId !== undefined) {
      // Remove existing labels for this document
      await tx.delete(documentLabels).where(eq(documentLabels.documentId, id));

      // Add new label if not null
      if (updates.labelId) {
        await tx.insert(documentLabels).values({
          documentId: id,
          labelId: updates.labelId,
        });
      }
    }

    // Update entity links if entities are provided
    if (updates.entities !== undefined) {
      // Remove all existing entity links for this document
      await tx
        .delete(documentEntities)
        .where(eq(documentEntities.documentId, id));

      // Insert new entity links
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

    // Invalidate cache
    await deleteKeysByPrefix(`document:${id}`);

    return doc;
  });

  // Trigger vector refresh (fire-and-forget)
  triggerDocumentVectorRefresh(id, teamId, organizationId).catch(() => {});

  return updatedDoc;
};
