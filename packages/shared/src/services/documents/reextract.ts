import { eq } from "drizzle-orm";
import db from "../../db";
import { documents } from "../../db/schema/documents";
import { buildDocumentOriginalKey } from "../../lib/document-storage";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import { emitUploadEvent } from "../../lib/upload-events";
import { reenqueueDocumentProcessing } from "./processing-queue";

/**
 * Re-run the extraction pipeline for one already-uploaded document. OCR is
 * reused from the content-addressed cache (deterministic), but classification +
 * entity extraction re-run against the team's CURRENT field definitions and
 * model — the point of a re-extraction after a failed run, a template change, or
 * a model upgrade. The original bytes still live on S3, so the job is rebuilt
 * from the stored row; the document flips back to `processing` and the existing
 * upload SSE stream reports its progress.
 */
export const reextractDocument = async (input: {
  documentId: string;
  teamId: string;
  organizationId: string;
}): Promise<void> => {
  const doc = await db.query.documents.findFirst({
    columns: {
      id: true,
      teamId: true,
      folderId: true,
      originalFilename: true,
      fileSize: true,
      mimeType: true,
      fileHash: true,
      status: true,
    },
    where: { id: input.documentId, teamId: input.teamId },
  });
  if (!doc) {
    return throwHttpError(404, notFound("Document not found"));
  }
  // Only a settled document can be re-extracted; one still in the pipeline is
  // already being processed.
  if (doc.status !== "ready" && doc.status !== "error") {
    return throwHttpError(
      400,
      badRequest("Document is still processing; wait for it to settle first."),
    );
  }

  // Flip to `processing` BEFORE enqueue: the worker early-returns on a `ready`
  // document, so the status must already reflect the re-run when the job lands.
  await db
    .update(documents)
    .set({ status: "processing" })
    .where(eq(documents.id, doc.id));
  emitUploadEvent({ documentId: doc.id, status: "processing" });

  try {
    await reenqueueDocumentProcessing({
      documentId: doc.id,
      organizationId: input.organizationId,
      teamId: doc.teamId,
      originalKey: buildDocumentOriginalKey(doc.id, doc.originalFilename),
      metadata: {
        id: doc.id,
        folderId: doc.folderId,
        originalFilename: doc.originalFilename,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
        fileHash: doc.fileHash,
      },
    });
  } catch (err) {
    // Enqueue failed (e.g. Redis down) — don't strand the document in
    // `processing`; surface an error the user can retry from.
    await db
      .update(documents)
      .set({ status: "error" })
      .where(eq(documents.id, doc.id));
    emitUploadEvent({ documentId: doc.id, status: "error" });
    throw err;
  }
};
