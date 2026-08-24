import { randomUUIDv7 } from "bun";

import db from "../../../db";
import { documentVersions, type Document } from "../../../db/schema/documents";
import { buildDocumentOriginalKey } from "../../../lib/document-storage";
import { uploadToS3 } from "../../../lib/s3";
import type { EventActor } from "../../domain-events/emit";
import { syncDocumentGraph } from "../sync-document-graph";
import { createDocumentRecord } from "../upload";
import { scheduleDocumentVectorRefresh } from "../vector-refresh-queue";
import type { DocumentVersionActorContext } from "../versions/record";

/**
 * Create a document by WRITING it rather than uploading it.
 *
 * The result is an ordinary Drive document — same table, same mirror record in
 * the graph, same links, same RAG index, same permissions. That is the whole
 * point of authoring into `documents` instead of a separate store: a written
 * deliverable is searchable, mentionable and shareable on day one, with no
 * second content silo to teach every feature about.
 *
 * Synchronous, unlike an upload: there is nothing to convert, OCR or
 * thumbnail, so parking the row in `converting` and waiting on a worker would
 * only make a document that is already complete look broken. The graph mirror
 * is written inline for the same reason — the caller gets back a document that
 * is fully usable, not one that will be shortly.
 */

/** Longest filename we mint from a title, extension excluded. */
const MAX_TITLE_LENGTH = 120;

/**
 * Turn a user-supplied title into a safe `.md` filename.
 *
 * Path separators and control characters are stripped rather than escaped: the
 * value becomes part of an S3 key and is echoed in download headers, so the
 * only safe answer is for it to contain none of them.
 */
export const titleToFilename = (title: string): string => {
  const cleaned = title
    // Control chars, path separators, and the characters Windows reserves in
    // filenames — a title travels into an S3 key and a Content-Disposition
    // header, so they are removed rather than escaped.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
  return `${cleaned.length > 0 ? cleaned : "Untitled"}.md`;
};

export const createAuthoredDocument = async (args: {
  organizationId: string;
  teamId: string;
  userId: string;
  title: string;
  content: string;
  folderId?: string | null;
  actorContext: DocumentVersionActorContext;
  /** Attribution for the `document.uploaded` journal entry + mirror record. */
  eventActor?: EventActor;
}): Promise<Document> => {
  const {
    organizationId,
    teamId,
    userId,
    content,
    folderId = null,
    actorContext,
  } = args;

  const documentId = randomUUIDv7();
  const originalFilename = titleToFilename(args.title);
  const bytes = new TextEncoder().encode(content);
  const metadata = {
    id: documentId,
    folderId,
    originalFilename,
    fileSize: bytes.length,
    mimeType: "text/markdown",
    fileHash: Bun.SHA256.hash(bytes, "hex"),
  };

  // Bytes first — the durability boundary. Everything below can be retried
  // against a file that is already safe.
  const originalKey = buildDocumentOriginalKey(documentId, originalFilename);
  await uploadToS3({
    buffer: bytes,
    key: originalKey,
    contentType: "text/markdown; charset=utf-8",
    documentId,
    organizationId,
    teamId,
  });

  const document = await createDocumentRecord({
    metadata,
    teamId,
    userId,
    source: "authored",
    status: "ready",
  });

  // v1's storageKey is the live original — the newest version always is. So
  // creating a document costs no extra byte on S3.
  await db.insert(documentVersions).values({
    documentId,
    teamId,
    versionNumber: 1,
    operation: "create",
    storageKey: originalKey,
    mimeType: metadata.mimeType,
    fileSize: metadata.fileSize,
    fileHash: metadata.fileHash,
    byUserId: actorContext.userId,
    byActor: actorContext.actor,
    byConversationId: actorContext.conversationId ?? null,
  });

  // Mirror into the graph exactly as the ingestion pipeline would, minus what
  // extraction produces: no custom fields and no mentions yet. Both arrive if
  // the user asks for a re-extraction, which an authored document supports
  // like any other.
  await syncDocumentGraph({
    organizationId,
    teamId,
    documentId,
    folderId,
    filename: originalFilename,
    customFields: {},
    mentions: [],
    ...(args.eventActor ? { actor: args.eventActor } : {}),
  });

  await scheduleDocumentVectorRefresh({ documentId, teamId, organizationId });

  return document;
};
