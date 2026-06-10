import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { buildSessionKey } from "@fretik/shared/lib/chatbot-session-storage";
import { getObjectBytes } from "@fretik/shared/lib/s3";
import { uploadDocument } from "@fretik/shared/services/documents/upload";
import { isDriveSupported } from "@fretik/shared/utils/mimeTypes";
import { eq, inArray } from "drizzle-orm";
import { WORKSPACE_DIRS } from "../../lib/conversation-storage";

/**
 * Promote already-uploaded chat-files to the team's Drive (`documents`
 * table). Called from the new POST `/conversation/:id/files/promote-to-drive`
 * route so the toggle's value is read at message-send time, not at
 * file-selection time (the latter raced with the eager upload and made
 * the toggle look broken).
 *
 * For each fileId:
 *  1. Verify the row belongs to `conversationId` + `teamId`.
 *  2. Skip if `documentId` is already set (idempotent — re-clicking
 *     send on a turn that already promoted the files is a no-op).
 *  3. Fetch the original bytes from S3 (`chatbot-sessions/{conv}/attachments/{filename}`).
 *  4. Reconstruct a `File` and call `uploadDocument()` to reuse the
 *     full Drive pipeline (validation, S3, pre-extract, vectorize).
 *  5. Persist the resulting `documents.id` back on the chat-file row.
 *
 * Best-effort: per-file failures are collected in `failed` instead of
 * aborting the whole batch. The chat attachment itself is unaffected.
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
    // unsupported type is reported cleanly instead of throwing a generic
    // 400 inside `uploadDocument` → `assertFile`.
    if (!isDriveSupported(row.mimeType)) {
      failed.push({
        fileId,
        reason: `Drive does not accept ${row.mimeType} files`,
        code: "unsupported_type",
      });
      continue;
    }

    try {
      const bytes = await getObjectBytes(
        buildSessionKey(conversationId, buildAttachmentPath(row.filename)),
      );
      if (!bytes) {
        failed.push({
          fileId,
          reason: "Original bytes missing from S3",
          code: "error",
        });
        continue;
      }

      const file = new File([bytes], row.filename, { type: row.mimeType });

      const document = await uploadDocument(
        file,
        organizationId,
        teamId,
        userId,
        undefined,
      );

      await db
        .update(aiChatFiles)
        .set({ documentId: document.id })
        .where(eq(aiChatFiles.id, fileId));

      promoted.push({ fileId, documentId: document.id });
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
