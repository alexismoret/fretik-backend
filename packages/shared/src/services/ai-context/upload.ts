import { randomUUIDv7 } from "bun";
import { eq } from "drizzle-orm";
import { extname } from "path";
import db from "../../db";
import {
  aiContextFiles,
  aiContextProfiles,
  type AiContextFile,
  type AiContextProfile,
} from "../../db/schema/ai-context";
import { shouldWriteSidecar } from "../../file-types";
import { resolveFileType } from "../../file-types/detect";
import { uploadContextSidecar } from "../../lib/ai-context-storage";
import {
  fileTooLarge,
  throwHttpError,
  unsupportedMediaType,
} from "../../lib/errors";
import { getPresignedUrl, putObject } from "../../lib/s3";
import { getOrCreateExtraction } from "../file-extraction/extract";
import { findContextProfile, type ScopeKey } from "./retrieve";
import { triggerContextVectorRefresh } from "./vector-refresh";

/**
 * Per-file size cap. 30 MB (raised from 15 MB, 2026-06) — matches the
 * Claude Projects cap, and safe here because context is RAG-consumed, not
 * inlined: a context file's system-prompt footprint is BOUNDED (manifest
 * = outline + 200-char preview via `build-manifest.ts`), full content is
 * lazy-read (`read("context/<file>")`) + chunked/vectorised for
 * `searchKnowledge`. File SIZE doesn't bloat the prompt; only total file
 * COUNT does (advisory `CHATBOT_CONTEXT_MAX_CHARS` manifest budget).
 */
export const CHATBOT_CONTEXT_MAX_FILE_SIZE = 30 * 1024 * 1024;

/**
 * S3 key namespace for context-file binaries. Kept separate from the
 * documents pipeline (`documents/`) and the chatbot session folder
 * (`chatbot-sessions/`) so a bucket listing tells operators at a
 * glance what a key is for.
 */
const s3KeyFor = (profileId: string, fileId: string, ext: string): string =>
  `ai-context/${profileId}/${fileId}${ext}`;

const assertSize = (file: File): void => {
  if (file.size > CHATBOT_CONTEXT_MAX_FILE_SIZE) {
    throwHttpError(
      413,
      fileTooLarge(file.name, file.size, CHATBOT_CONTEXT_MAX_FILE_SIZE),
    );
  }
};

/**
 * Upsert the profile row (creates it lazily the first time a user /
 * team uploads a file or saves instructions). Factored here because
 * the upload path and the update-instructions path both need it.
 */
export const findOrCreateContextProfile = async (
  scope: ScopeKey,
): Promise<AiContextProfile> => {
  if (scope.scope === "team" && !scope.teamId) {
    return throwHttpError(403, {
      code: "TEAM_REQUIRED",
      message: "No active team — cannot create a team context profile.",
    });
  }

  const existing = await findContextProfile(scope);
  if (existing) return existing;

  const [created] = await db
    .insert(aiContextProfiles)
    .values({
      scope: scope.scope,
      organizationId: scope.organizationId,
      teamId: scope.scope === "team" ? scope.teamId : null,
      userId: scope.scope === "user" ? scope.userId : null,
      instructions: "",
      updatedById: scope.userId,
    })
    .returning();

  if (!created) {
    return throwHttpError(500, {
      code: "INTERNAL_ERROR",
      message: "Failed to create context profile",
    });
  }
  return created;
};

/**
 * Run the extraction for a staged file and flip its status. On
 * success populates `content / charCount / pageCount / hasMarkdown`
 * AND uploads the OCR markdown sidecar to S3 when applicable; on
 * failure moves the row to `status: "error"` with a human-readable
 * message so the UI can surface it in the file list.
 */
const runExtractionForFile = async (args: {
  fileId: string;
  profileId: string;
  organizationId: string;
  fileHash: string;
  s3Key: string;
  mimeType: string;
  filename: string;
  bytes: Uint8Array;
}): Promise<void> => {
  await db
    .update(aiContextFiles)
    .set({ status: "extracting" })
    .where(eq(aiContextFiles.id, args.fileId));

  try {
    // Route extraction through the shared content-addressed cache so a
    // file already OCR'd on another surface (chat attachment, Drive
    // document) is reused, and this extraction populates the cache for
    // them in turn. OCR uses the RAW Mistral client here (this runs
    // outside a chat turn / pipeline trace).
    const extraction = await getOrCreateExtraction({
      organizationId: args.organizationId,
      fileHash: args.fileHash,
      mimeType: args.mimeType,
      filename: args.filename,
      fileSizeBytes: args.bytes.byteLength,
      getBytes: () => Promise.resolve(args.bytes),
      getPresignedUrl: () => getPresignedUrl(args.s3Key, 60 * 10),
    });
    if (extraction.error) throw new Error(extraction.error);

    const content = extraction.markdown ?? "";
    const writeSidecar = shouldWriteSidecar(args.mimeType, content);
    if (writeSidecar) {
      // Persist the markdown sidecar BEFORE flipping status so that
      // any conversation that hydrates the moment the row turns
      // ready already finds the file on S3. Errors here are fatal
      // for this extraction attempt — the catch below will mark the
      // row as `error` and the user can retry by re-uploading.
      await uploadContextSidecar(args.profileId, args.fileId, content);
    }

    await db
      .update(aiContextFiles)
      .set({
        status: "ready",
        content,
        charCount: extraction.charCount,
        pageCount: extraction.pageCount,
        hasMarkdown: writeSidecar,
        errorMessage: null,
      })
      .where(eq(aiContextFiles.id, args.fileId));

    // Fire-and-forget RAG indexing. The aiContextFiles row is the
    // source of truth, so vectorisation must never block (or roll
    // back) the user-visible status flip. `triggerContextVectorRefresh`
    // swallows errors internally.
    void triggerContextVectorRefresh(args.fileId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[ai-context] parsing failed for file ${args.fileId} (${args.filename}):`,
      message,
    );
    await db
      .update(aiContextFiles)
      .set({ status: "error", errorMessage: message })
      .where(eq(aiContextFiles.id, args.fileId));
  }
};

export interface UploadContextFileArgs {
  file: File;
  scope: ScopeKey;
  uploadedById: string;
}

/**
 * Upload a single context file. Returns the row once the bytes are
 * safely on S3 and the DB row is inserted with `status: "extracting"`.
 * Extraction continues in the background; the settings UI polls
 * `GET /chatbot-context/:scope` until every file has left the
 * transient states.
 */
export const uploadContextFile = async (
  args: UploadContextFileArgs,
): Promise<AiContextFile> => {
  assertSize(args.file);

  const profile = await findOrCreateContextProfile(args.scope);

  const arrayBuffer = await args.file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const fileHash = Bun.SHA256.hash(arrayBuffer, "hex");
  // Resolve the REAL type from the bytes, then accept or reject on THAT.
  // Validating the browser-declared type and storing the detected one
  // would let a file in under one identity and file it under another.
  const resolved = await resolveFileType({
    bytes,
    declaredMime: args.file.type,
    filename: args.file.name,
  });
  if (!resolved.type?.surfaces.includes("context")) {
    throwHttpError(415, unsupportedMediaType(resolved.mimeType));
  }
  const mimeType = resolved.mimeType;

  const fileId = randomUUIDv7();
  const ext = extname(args.file.name).toLowerCase();
  const s3Key = s3KeyFor(profile.id, fileId, ext);

  // Reject duplicate filenames eagerly so the user sees "already
  // uploaded" instead of a confusing DB unique violation.
  const existingByName = await db.query.aiContextFiles.findFirst({
    where: {
      profileId: profile.id,
      filename: args.file.name,
    },
    columns: { id: true },
  });
  if (existingByName) {
    return throwHttpError(409, {
      code: "FILE_ALREADY_EXISTS",
      message: `A file named "${args.file.name}" already exists in this context. Delete it first or rename before re-uploading.`,
    });
  }

  await putObject({
    key: s3Key,
    body: bytes,
    contentType: mimeType,
    metadata: {
      profileId: profile.id,
      organizationId: args.scope.organizationId,
    },
  });

  const [inserted] = await db
    .insert(aiContextFiles)
    .values({
      id: fileId,
      profileId: profile.id,
      organizationId: args.scope.organizationId,
      filename: args.file.name,
      mimeType,
      size: args.file.size,
      fileHash,
      s3Key,
      status: "uploading",
      uploadedById: args.uploadedById,
    })
    .returning();

  if (!inserted) {
    return throwHttpError(500, {
      code: "INTERNAL_ERROR",
      message: "Failed to insert context file row",
    });
  }

  // Fire-and-forget extraction. The returned promise is intentionally
  // not awaited — the UI polls until status flips. Errors are caught
  // inside `runExtractionForFile` and persisted on the row.
  void runExtractionForFile({
    fileId: inserted.id,
    profileId: profile.id,
    organizationId: args.scope.organizationId,
    fileHash,
    s3Key,
    mimeType,
    filename: args.file.name,
    bytes,
  });

  return inserted;
};
