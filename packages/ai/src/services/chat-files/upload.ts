import db from "@fretik/shared/db";
import { aiChatFiles, type AiChatFile } from "@fretik/shared/db/schema";
import {
  extractChatFileSnapshot,
  type ChatFileSnapshot,
} from "@fretik/shared/lib/chat-file-snapshot";
import { sanitizeSessionPath } from "@fretik/shared/lib/chatbot-session-storage";
import {
  conversationFileLimitReached,
  fileTooLarge,
  forbidden,
  notFound,
  throwHttpError,
  unsupportedMediaType,
} from "@fretik/shared/lib/errors";
import { uploadDocument } from "@fretik/shared/services/documents/upload";
import {
  CHAT_FILE_ERROR_CODES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_CONVERSATION,
} from "@fretik/shared/utils/chatbot-limits";
import { isChatbotSupported } from "@fretik/shared/utils/mimeTypes";
import { and, eq, ne } from "drizzle-orm";
import { attachUserFile, readFileText } from "../../lib/conversation-storage";
import { preprocessChatFile } from "./preprocess";

/**
 * Chat-file upload orchestrator. Called from the chat-files POST
 * route. Responsibilities:
 *
 *  1. Verify the conversation exists and belongs to the calling team.
 *  2. Validate file size / MIME / aggregate conversation cap
 *     (HTTP 413 / 415 / 409 respectively).
 *  3. Dedup the filename on `(conversationId, filename)` UNIQUE by
 *     appending `_2`, `_3`, … when a collision is detected.
 *  4. INSERT an `ai_chat_files` row in `status: 'uploading'` and grab
 *     the generated id.
 *  5. Push the raw bytes into the conversation sandbox under
 *     `/workspace/attachments/{filename}` via the conversation-storage
 *     façade. The façade also queues an async S3 backup so a sandbox
 *     recreated after expiry can be re-hydrated.
 *  6. Run `preprocessChatFile` synchronously — OCR for PDF / DOCX /
 *     PPTX / images, no-op passthrough for everything else.
 *  7. Optionally upload to Drive in parallel (via the existing
 *     `documents` pipeline) and persist the resulting `documentId`
 *     on the row.
 *  8. UPDATE the row to `status: 'ready'` with final metadata.
 *     Any failure between 5-7 flips the row to `status: 'error'`
 *     with the message and re-throws so the handler can bubble it
 *     up to the client.
 */

interface UploadChatFileArgs {
  file: File;
  conversationId: string;
  organizationId: string;
  teamId: string;
  userId: string;
  alsoUploadToDrive: boolean;
}

const resolveDedupedFilename = async (
  conversationId: string,
  originalName: string,
): Promise<string> => {
  const existing = await db
    .select({ filename: aiChatFiles.filename })
    .from(aiChatFiles)
    .where(eq(aiChatFiles.conversationId, conversationId));

  const taken = new Set(existing.map((r) => r.filename));
  if (!taken.has(originalName)) return originalName;

  const dotIndex = originalName.lastIndexOf(".");
  const base = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  const ext = dotIndex > 0 ? originalName.slice(dotIndex) : "";

  // Sanitize-safe suffix format: `_N` instead of ` (N)`. The
  // enclosing filename is already sanitized by the caller, and `_`,
  // digits, and `.` all survive `sanitizeSessionPath` so the deduped
  // name maps 1:1 to its on-disk basename.
  for (let i = 2; i < 1_000; i += 1) {
    const candidate = `${base}_${i.toString()}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${base}_${Date.now().toString()}${ext}`;
};

const countActiveFiles = async (conversationId: string): Promise<number> => {
  const rows = await db
    .select({ id: aiChatFiles.id })
    .from(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        ne(aiChatFiles.status, "error"),
      ),
    );
  return rows.length;
};

export const uploadChatFile = async (
  args: UploadChatFileArgs,
): Promise<AiChatFile> => {
  const { file, conversationId, teamId, userId } = args;

  // 1. Conversation ownership.
  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: { id: true, teamId: true },
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }
  if (conversation.teamId !== teamId) {
    return throwHttpError(403, forbidden());
  }

  // 2. Size / MIME / aggregate cap.
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return throwHttpError(
      413,
      fileTooLarge(file.name, file.size, MAX_FILE_SIZE_BYTES),
    );
  }
  if (!isChatbotSupported(file.type)) {
    return throwHttpError(415, unsupportedMediaType(file.type));
  }
  const activeCount = await countActiveFiles(conversationId);
  if (activeCount >= MAX_FILES_PER_CONVERSATION) {
    return throwHttpError(
      409,
      conversationFileLimitReached(MAX_FILES_PER_CONVERSATION),
    );
  }

  // 3. Sanitize the original filename FIRST, then dedup against
  //    existing sanitized names. The stored value must equal the
  //    on-disk basename so every downstream surface
  //    (`/workspace/attachments/{filename}` in the sandbox, the S3
  //    backup key under `attachments/{filename}`,
  //    `{{attachedFilesBlock}}`, FileUIPart.filename, DELETE /
  //    download routes) lines up without a second-pass translation.
  //    Spaces / parens / accents all collapse to `_` via
  //    sanitizeSessionPath — accepted cost for consistency.
  const sanitizedBase = sanitizeSessionPath(file.name);
  const dedupedFilename = await resolveDedupedFilename(
    conversationId,
    sanitizedBase,
  );

  // 4. Insert row in 'uploading' state.
  const [inserted] = await db
    .insert(aiChatFiles)
    .values({
      conversationId,
      uploadedById: userId,
      filename: dedupedFilename,
      mimeType: file.type,
      size: file.size,
      status: "uploading",
    })
    .returning();

  if (!inserted) {
    return throwHttpError(500, {
      code: CHAT_FILE_ERROR_CODES.FILE_TOO_LARGE,
      message: "Failed to create chat file row",
    });
  }

  const fileId = inserted.id;

  try {
    // 5. Push the raw bytes into the conversation sandbox (and queue
    //    the async S3 backup) via the storage façade. Triggers
    //    sandbox bootstrap on first call — workspace dirs are created,
    //    bundled skills pushed, attachments/outputs restored from S3
    //    if any.
    const bytes = new Uint8Array(await file.arrayBuffer());
    await attachUserFile(conversationId, dedupedFilename, bytes, file.type);

    // 6. Synchronous preprocess (OCR sidecar for PDF / DOCX / PPTX /
    //    images that produce useful text).
    const preprocess = await preprocessChatFile({
      fileId,
      conversationId,
      filename: dedupedFilename,
      mimeType: file.type,
    });

    // 6b. Snapshot extraction (Pattern A — see plan
    //     `mission-enrichir-le-glowing-castle.md`). Pure function over
    //     the bytes already in memory + the OCR sidecar markdown when
    //     one was written. Failures fall back to `opaque` instead of
    //     throwing — never break the upload because of preview
    //     extraction.
    let snapshot: ChatFileSnapshot;
    try {
      const ocrSidecar = preprocess.sidecarPath
        ? {
            markdown: await readFileText(
              conversationId,
              preprocess.sidecarPath,
            ),
            pageCount: preprocess.pageCount,
          }
        : undefined;
      snapshot = await extractChatFileSnapshot(bytes, file.type, ocrSidecar);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      snapshot = {
        kind: "opaque",
        reason: `snapshot extraction failed: ${message.slice(0, 100)}`,
      };
    }

    // 7. Optional Drive parallel upload.
    let documentId: string | null = null;
    if (args.alsoUploadToDrive) {
      try {
        const doc = await uploadDocument(
          file,
          args.organizationId,
          teamId,
          userId,
          undefined,
        );
        documentId = doc.id;
      } catch (err) {
        // Drive upload is best-effort — a failure here shouldn't fail
        // the chat attachment itself. Log and continue; the row just
        // keeps `documentId = null`.
        console.warn(
          "[chat-files/upload] Drive upload failed, chat attachment still usable:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 8. Finalize.
    const [finalized] = await db
      .update(aiChatFiles)
      .set({
        status: "ready",
        hasMarkdown: preprocess.hasMarkdown,
        documentId,
        snapshot,
      })
      .where(eq(aiChatFiles.id, fileId))
      .returning();

    if (!finalized) {
      throw new Error("Row disappeared between insert and finalize");
    }
    return finalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(aiChatFiles)
      .set({ status: "error", errorMessage: message })
      .where(eq(aiChatFiles.id, fileId));
    throw err;
  }
};
