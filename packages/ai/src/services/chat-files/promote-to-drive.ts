import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { buildSessionKey } from "@fretik/shared/lib/chatbot-session-storage";
import { buildDocumentOriginalKey } from "@fretik/shared/lib/document-storage";
import { copyObject } from "@fretik/shared/lib/s3";
import { finalizeFailedDocument } from "@fretik/shared/services/documents/process";
import { enqueueDocumentProcessing } from "@fretik/shared/services/documents/processing-queue";
import { createDocumentRecord } from "@fretik/shared/services/documents/upload";
import { isDriveSupported } from "@fretik/shared/utils/mimeTypes";
import { randomUUIDv7 } from "bun";
import { eq, inArray } from "drizzle-orm";
import { WORKSPACE_DIRS } from "../../lib/conversation-storage";

/**
 * Promote already-uploaded chat-files to the team's Drive (`documents`
 * table). Called from the POST `/conversation/:id/files/promote-to-drive`
 * route so the toggle's value is read at message-send time, not at
 * file-selection time (the latter raced with the eager upload and made
 * the toggle look broken).
 *
 * For each fileId:
 *  1. Verify the row belongs to `conversationId` + `teamId`.
 *  2. Skip if `documentId` is already set (idempotent).
 *  3. Insert the `documents` row, server-side COPY the attachment's S3
 *     object onto the document's original key (no bytes pulled into the
 *     AI process), then enqueue the shared document-processing job.
 *  4. Persist the resulting `documents.id` back on the chat-file row.
 *
 * The heavy work (OCR / conversion / vectorisation) runs in the API-side
 * BullMQ worker, so promotion never blocks the chat stream. Best-effort:
 * per-file failures are collected in `failed` instead of aborting the
 * whole batch.
 */

interface PromoteArgs {
  fileIds: string[];
  conversationId: string;
  organizationId: string;
  teamId: string;
  userId: string;
}

/** Why a file could not be promoted — lets the UI pick the right copy. */
export type PromoteFailureCode = "unsupported_type" | "error";

export interface PromoteResult {
  promoted: { fileId: string; documentId: string }[];
  failed: { fileId: string; reason: string; code: PromoteFailureCode }[];
}

const buildAttachmentPath = (filename: string): string =>
  `${WORKSPACE_DIRS.attachments}/${filename}`;

export const promoteChatFilesToDrive = async (
  args: PromoteArgs,
): Promise<PromoteResult> => {
  const { fileIds, conversationId, organizationId, teamId, userId } = args;

  const promoted: PromoteResult["promoted"] = [];
  const failed: PromoteResult["failed"] = [];

  if (fileIds.length === 0) return { promoted, failed };

  // Single batched read — verify ownership and grab metadata in one query.
  const rows = await db
    .select({
      id: aiChatFiles.id,
      conversationId: aiChatFiles.conversationId,
      filename: aiChatFiles.filename,
      mimeType: aiChatFiles.mimeType,
      fileHash: aiChatFiles.fileHash,
      size: aiChatFiles.size,
      documentId: aiChatFiles.documentId,
    })
    .from(aiChatFiles)
    .where(inArray(aiChatFiles.id, fileIds));

  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: { id: true, teamId: true },
  });
  if (!conversation || conversation.teamId !== teamId) {
    for (const fileId of fileIds) {
      failed.push({
        fileId,
        reason: "Conversation not found or not owned",
        code: "error",
      });
    }
    return { promoted, failed };
  }

  const rowsById = new Map(rows.map((r) => [r.id, r]));

  for (const fileId of fileIds) {
    const row = rowsById.get(fileId);
    if (!row) {
      failed.push({ fileId, reason: "Chat file not found", code: "error" });
      continue;
    }
    if (row.conversationId !== conversationId) {
      failed.push({
        fileId,
        reason: "Chat file does not belong to conversation",
        code: "error",
      });
      continue;
    }
    if (row.documentId) {
      // Already promoted — idempotent success.
      promoted.push({ fileId, documentId: row.documentId });
      continue;
    }
    // The chatbot accepts a broader MIME set than the Drive pipeline
    // (markdown / JSON / XML / arbitrary text). Pre-check so an
    // unsupported type is reported cleanly.
    if (!isDriveSupported(row.mimeType)) {
      failed.push({
        fileId,
        reason: `Drive does not accept ${row.mimeType} files`,
        code: "unsupported_type",
      });
      continue;
    }
    if (!row.fileHash) {
      failed.push({
        fileId,
        reason: "Chat file has no content hash",
        code: "error",
      });
      continue;
    }

    try {
      const documentId = randomUUIDv7();
      const metadata = {
        id: documentId,
        folderId: null,
        originalFilename: row.filename,
        fileSize: row.size,
        mimeType: row.mimeType,
        fileHash: row.fileHash,
      };
      const originalKey = buildDocumentOriginalKey(documentId, row.filename);

      // Server-side copy: attachment → document original key. Done before
      // the row is created/enqueued so the worker always finds the bytes.
      await copyObject({
        sourceKey: buildSessionKey(
          conversationId,
          buildAttachmentPath(row.filename),
        ),
        destinationKey: originalKey,
        contentType: row.mimeType,
        metadata: { documentId, organizationId, teamId },
      });

      await createDocumentRecord({ metadata, teamId, userId });

      // Enqueue after the row + bytes exist. On failure (Redis down),
      // finalize the document to a clean `error` state instead of leaving
      // it stuck, then bubble up to the per-file failure handler.
      try {
        await enqueueDocumentProcessing({
          documentId,
          organizationId,
          teamId,
          originalKey,
          metadata,
        });
      } catch (enqueueErr) {
        const message =
          enqueueErr instanceof Error
            ? enqueueErr.message
            : "Failed to enqueue processing";
        await finalizeFailedDocument(
          { documentId, organizationId, teamId, originalKey, metadata },
          message,
        );
        throw enqueueErr;
      }

      await db
        .update(aiChatFiles)
        .set({ documentId })
        .where(eq(aiChatFiles.id, fileId));

      promoted.push({ fileId, documentId });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[chat-files/promote-to-drive] Failed for ${fileId}:`,
        reason,
      );
      failed.push({ fileId, reason, code: "error" });
    }
  }

  return { promoted, failed };
};
