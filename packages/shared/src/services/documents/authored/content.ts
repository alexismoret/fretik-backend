import db from "../../../db";
import type { Document, DocumentVersion } from "../../../db/schema/documents";
import { isMarkdownMime } from "../../../file-types";
import { buildDocumentOriginalKey } from "../../../lib/document-storage";
import { createApiError, notFound, throwHttpError } from "../../../lib/errors";
import { getObjectBytes } from "../../../lib/s3";
import { ERROR_CODES } from "../../../schemas/errors";
import type { DocumentVersionActorContext } from "../versions/record";
import { replaceDocumentContent } from "../versions/replace-content";

/**
 * Read and write a document's TEXT.
 *
 * A thin, typed skin over the generic byte paths: the content lives in the one
 * S3 object the rest of the pipeline already treats as this document's
 * original, so there is no second place for it to be and nothing to keep in
 * sync. Writing goes through `replaceDocumentContent`, which is what makes an
 * in-app save produce the same versions, the same history and the same restore
 * as any other change to the document.
 */

/**
 * Editability follows the FORMAT, not the provenance.
 *
 * Deliberately not `source === "authored"`: a markdown someone uploaded and a
 * markdown written here are the same file, and a user cannot see why one would
 * open in the editor and the other would not. `source` stays honest about
 * where a document came from — it just does not decide what you may do with it.
 */
const assertEditableAsText = (document: Document): void => {
  if (!isMarkdownMime(document.mimeType)) {
    throwHttpError(
      400,
      createApiError(
        ERROR_CODES.DOCUMENT_NOT_AUTHORED,
        `Only text documents can be read or edited as text (this one is ${document.mimeType}).`,
      ),
    );
  }
};

export interface AuthoredContent {
  document: Document;
  content: string;
}

export const getAuthoredContent = async (args: {
  documentId: string;
  teamId: string;
}): Promise<AuthoredContent> => {
  const document = await db.query.documents.findFirst({
    where: { id: args.documentId, teamId: args.teamId },
  });
  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }
  assertEditableAsText(document);

  const bytes = await getObjectBytes(
    buildDocumentOriginalKey(document.id, document.originalFilename),
  );
  if (!bytes) {
    // The row exists but its object does not — a partial delete or a failed
    // write. Say so rather than serving an empty editor the user would then
    // save over the top of.
    return throwHttpError(
      404,
      notFound("This document's content is missing from storage."),
    );
  }

  return { document, content: new TextDecoder().decode(bytes) };
};

export const saveAuthoredContent = async (args: {
  documentId: string;
  teamId: string;
  organizationId: string;
  content: string;
  actorContext: DocumentVersionActorContext;
  /** Reject the save if the document moved since it was loaded (409). */
  expectedUpdatedAt?: Date;
  /** Reject the save if the CONTENT changed since it was read (409) — the
   * agent's read-before-write check. See `replaceDocumentContent`. */
  expectedFileHash?: string;
}): Promise<{
  document: Document;
  version: DocumentVersion;
  unchanged: boolean;
}> => {
  const document = await db.query.documents.findFirst({
    where: { id: args.documentId, teamId: args.teamId },
  });
  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }
  assertEditableAsText(document);

  return replaceDocumentContent({
    documentId: args.documentId,
    teamId: args.teamId,
    organizationId: args.organizationId,
    bytes: new TextEncoder().encode(args.content),
    operation: "edit",
    actorContext: args.actorContext,
    ...(args.expectedUpdatedAt
      ? { expectedUpdatedAt: args.expectedUpdatedAt }
      : {}),
    ...(args.expectedFileHash
      ? { expectedFileHash: args.expectedFileHash }
      : {}),
  });
};
