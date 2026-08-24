import { randomUUIDv7 } from "bun";

import db from "../../db";
import { documentVersions } from "../../db/schema";
import { resolveFileType } from "../../file-types/detect";
import { readSessionFile } from "../../lib/chatbot-session-storage";
import { buildDocumentOriginalKey } from "../../lib/document-storage";
import { uploadToS3 } from "../../lib/s3";
import { finalizeFailedDocument } from "../documents/process";
import { enqueueDocumentProcessing } from "../documents/processing-queue";
import { createDocumentRecord } from "../documents/upload";
import type { DocumentVersionActorContext } from "../documents/versions/record";
import { replaceDocumentContent } from "../documents/versions/replace-content";

/**
 * Promote a file the agent PRODUCED — anything under its sandbox workspace —
 * into the team's Drive.
 *
 * The sibling `promote-to-drive.ts` handles files the USER attached, which
 * have an `ai_chat_files` row to hang the promotion off. Sandbox outputs have
 * no row at all: they are S3 objects under the conversation's session prefix
 * and nothing more. So the lookup is by path, and the type is resolved from
 * the bytes rather than read off a record.
 *
 * With `replaceDocumentId` the bytes become a new VERSION of an existing
 * document instead of a new one. That is the case the Drive was quietly
 * getting wrong: the agent regenerates a deliverable, promotes it, and the
 * team ends up with two same-named files and no link between them.
 */

export interface PromoteSandboxFileResult {
  documentId: string;
  filename: string;
  versionNumber: number;
  /** False when the bytes landed on an existing document as a new version. */
  created: boolean;
  /** True when the bytes matched the target's current content — a no-op. */
  unchanged: boolean;
}

export type PromoteSandboxFailureCode =
  "not_found" | "unsupported_type" | "empty";

export class PromoteSandboxFileError extends Error {
  constructor(
    readonly code: PromoteSandboxFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "PromoteSandboxFileError";
  }
}

export const promoteSandboxFileToDrive = async (args: {
  conversationId: string;
  /** Workspace-relative path, e.g. `outputs/rapport.pdf`. */
  path: string;
  organizationId: string;
  teamId: string;
  userId: string;
  folderId?: string | null;
  /** Land these bytes on an existing document as its next version. */
  replaceDocumentId?: string;
  actorContext: DocumentVersionActorContext;
}): Promise<PromoteSandboxFileResult> => {
  const { conversationId, path, organizationId, teamId, userId } = args;
  const folderId = args.folderId ?? null;

  const bytes = await readSessionFile(conversationId, path);
  if (!bytes) {
    throw new PromoteSandboxFileError(
      "not_found",
      `No file at "${path}" in this conversation's workspace.`,
    );
  }
  if (bytes.length === 0) {
    throw new PromoteSandboxFileError("empty", `"${path}" is empty.`);
  }

  const filename = path.split("/").pop() ?? path;
  const resolved = await resolveFileType({ bytes, filename });
  const mimeType = resolved.mimeType;
  if (!resolved.type?.surfaces.includes("drive")) {
    throw new PromoteSandboxFileError(
      "unsupported_type",
      `The Drive does not accept ${mimeType} files.`,
    );
  }

  if (args.replaceDocumentId) {
    const result = await replaceDocumentContent({
      documentId: args.replaceDocumentId,
      teamId,
      organizationId,
      bytes,
      operation: "replace",
      actorContext: args.actorContext,
      mimeType,
    });
    return {
      documentId: result.document.id,
      filename: result.document.originalFilename,
      versionNumber: result.version.versionNumber,
      created: false,
      unchanged: result.unchanged,
    };
  }

  const fileHash = Bun.SHA256.hash(bytes, "hex");

  // Promoting the same bytes to the same place twice is a repeat, not a second
  // document — the agent doing it inside one turn is the common case. Scoped to
  // the destination folder so an identical file deliberately filed in two
  // places still produces two documents.
  const alreadyThere = await db.query.documents.findFirst({
    columns: { id: true, originalFilename: true },
    where: {
      teamId,
      fileHash,
      ...(folderId === null ? { folderId: { isNull: true } } : { folderId }),
    },
  });
  if (alreadyThere) {
    return {
      documentId: alreadyThere.id,
      filename: alreadyThere.originalFilename,
      versionNumber: 1,
      created: false,
      unchanged: true,
    };
  }

  const documentId = randomUUIDv7();
  const metadata = {
    id: documentId,
    folderId,
    originalFilename: filename,
    fileSize: bytes.length,
    mimeType,
    fileHash,
  };
  const originalKey = buildDocumentOriginalKey(documentId, filename);

  // Bytes before the row, as everywhere else: the worker must always find them.
  await uploadToS3({
    buffer: bytes,
    key: originalKey,
    contentType: mimeType,
    documentId,
    organizationId,
    teamId,
  });

  // The row and its first version land together, or neither does.
  //
  // Leaving v1 to `getCurrentVersion` to materialise later loses the only
  // thing that says where these bytes came from: that back-fill reads the
  // document row, which knows an uploader but no conversation, so it stamps
  // `byActor: 'human'` and a null conversation. That link is load-bearing —
  // it is what lets a REGENERATED deliverable be recognised as a new version
  // of this document instead of a second one with the same name. A failure
  // between the two writes would silently produce exactly that.
  await db.transaction(async (tx) => {
    await createDocumentRecord({ metadata, teamId, userId, tx });
    await tx.insert(documentVersions).values({
      documentId,
      teamId,
      versionNumber: 1,
      operation: "create",
      storageKey: originalKey,
      mimeType,
      fileSize: bytes.length,
      fileHash,
      byUserId: args.actorContext.userId,
      byActor: args.actorContext.actor,
      byConversationId: args.actorContext.conversationId ?? null,
    });
  });

  try {
    await enqueueDocumentProcessing({
      documentId,
      organizationId,
      teamId,
      originalKey,
      metadata,
    });
  } catch (error) {
    // Nothing usable exists yet — no versions, no extraction — so the terminal
    // cleanup is the right response here (unlike a replacement, where it would
    // destroy a document whose new content is already safe).
    await finalizeFailedDocument(
      { documentId, organizationId, teamId, originalKey, metadata },
      error instanceof Error ? error.message : "Failed to enqueue processing",
    );
    throw error;
  }

  return {
    documentId,
    filename,
    versionNumber: 1,
    created: true,
    unchanged: false,
  };
};
