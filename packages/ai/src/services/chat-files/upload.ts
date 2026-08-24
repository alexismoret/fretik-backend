import db from "@fretik/shared/db";
import { aiChatFiles, type AiChatFile } from "@fretik/shared/db/schema";
import { expectsSidecar } from "@fretik/shared/file-types";
import { resolveFileType } from "@fretik/shared/file-types/detect";
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
import {
  CHAT_FILE_ERROR_CODES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_CONVERSATION,
} from "@fretik/shared/utils/chatbot-limits";
import { and, eq, ne } from "drizzle-orm";
import { attachUserFile } from "../../lib/conversation-storage";

// NOTE: promoting a chat file to the team Drive is a SEPARATE flow
// (`promote-to-drive.ts`, called at message-send time). The upload path
// never touches the Drive — the "Save to Drive" toggle is read on send,
// not at file-selection time.

/**
 * Chat-file upload orchestrator. Called from the chat-files POST
 * route. Responsibilities:
 *
 *  1. Verify the conversation exists and belongs to the calling team.
 *  2. Read the bytes once, resolve the REAL MIME from magic bytes
 *     (`resolveFileType` — never trust the extension / browser type),
 *     and validate size / MIME / aggregate conversation cap
 *     (HTTP 413 / 415 / 409 respectively).
 *  3. Hash the bytes (SHA-256) and dedup the filename on
 *     `(conversationId, filename)` UNIQUE by appending `_2`, `_3`, ….
 *  4. INSERT an `ai_chat_files` row in `status: 'uploading'` carrying the
 *     detected MIME + `fileHash`.
 *  5. Push the raw bytes into the conversation sandbox under
 *     `/workspace/attachments/{filename}` via the conversation-storage
 *     façade (+ async S3 backup for sandbox re-hydration).
 *  6. Extract a structured snapshot from the bytes for the UI / attached
 *     files block. NO OCR here — extraction is lazy (first `read`) and
 *     cached via `@fretik/shared/services/file-extraction`.
 *  7. UPDATE the row to `status: 'ready'`. Any failure between 5-6 flips
 *     the row to `status: 'error'` and re-throws.
 *
 * Drive promotion is intentionally NOT done here — see the note above
 * the imports.
 */

interface UploadChatFileArgs {
  file: File;
  conversationId: string;
  teamId: string;
  userId: string;
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

  // 2. Read the bytes once, resolve the REAL MIME from magic bytes
  //    (never trust the extension / browser-provided file.type), then
  //    validate size / MIME / aggregate cap.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const resolved = await resolveFileType({
    bytes,
    declaredMime: file.type,
    filename: file.name,
  });
  const mimeType = resolved.mimeType;

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return throwHttpError(
      413,
      fileTooLarge(file.name, file.size, MAX_FILE_SIZE_BYTES),
    );
  }
  if (!resolved.type?.surfaces.includes("chatbot")) {
    return throwHttpError(415, unsupportedMediaType(mimeType));
  }
  const activeCount = await countActiveFiles(conversationId);
  if (activeCount >= MAX_FILES_PER_CONVERSATION) {
    return throwHttpError(
      409,
      conversationFileLimitReached(MAX_FILES_PER_CONVERSATION),
    );
  }

  // 3. Hash the content (SHA-256 — the dedup key into `file_extractions`)
  //    and sanitize + dedup the filename. The stored filename must equal
  //    the on-disk basename so every downstream surface
  //    (`/workspace/attachments/{filename}`, the S3 backup key,
  //    `{{attachedFilesBlock}}`, FileUIPart.filename, DELETE / download
  //    routes) lines up without a second-pass translation. Spaces /
  //    parens / accents all collapse to `_` via sanitizeSessionPath.
  const fileHash = Bun.SHA256.hash(bytes, "hex");
  const sanitizedBase = sanitizeSessionPath(file.name);
  const dedupedFilename = await resolveDedupedFilename(
    conversationId,
    sanitizedBase,
  );

  // 4. Insert row in 'uploading' state with the detected MIME + hash.
  const [inserted] = await db
    .insert(aiChatFiles)
    .values({
      conversationId,
      uploadedById: userId,
      filename: dedupedFilename,
      mimeType,
      fileHash,
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
    // 5. Push the raw bytes into the conversation sandbox (+ async S3
    //    backup) via the storage façade. Triggers sandbox bootstrap on
    //    first call. NO OCR here — extraction is lazy (first `read`) and
    //    cached by `@fretik/shared/services/file-extraction`.
    await attachUserFile(conversationId, dedupedFilename, bytes, mimeType);

    // 6. Snapshot extraction (Pattern A) — pure function over the bytes
    //    already in memory. Tabular / text snapshots are exact; document
    //    snapshots (PDF / DOCX / PPTX / image) are lean until the first
    //    `read` populates the extraction cache. Failures fall back to
    //    `opaque` — never break the upload because of preview extraction.
    let snapshot: ChatFileSnapshot;
    try {
      snapshot = await extractChatFileSnapshot(
        bytes,
        mimeType,
        undefined,
        dedupedFilename,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      snapshot = {
        kind: "opaque",
        reason: `snapshot extraction failed: ${message.slice(0, 100)}`,
      };
    }

    // `hasMarkdown` reflects "a markdown sidecar is expected for this
    // type" (documents, images, mail, HTML) — it is produced lazily on
    // first `read`, not here. Text and source files never get one.
    const hasMarkdown = expectsSidecar(mimeType, dedupedFilename);

    // 7. Finalize. `documentId` stays null — it is set later, only if the
    // user promotes the file to the Drive on send (`promote-to-drive.ts`).
    const [finalized] = await db
      .update(aiChatFiles)
      .set({
        status: "ready",
        hasMarkdown,
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
