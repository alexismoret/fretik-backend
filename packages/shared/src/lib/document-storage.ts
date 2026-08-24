import { extname } from "node:path";
import { thumbnailFor } from "../file-types";
import { deleteObject, getObjectBytes, putObject } from "./s3";

/**
 * S3 layer for Drive documents (`documents` table). Each document has
 * an **original** key (raw bytes the user uploaded, e.g.
 * `documents/{documentId}.pdf`) and an optional **sidecar** key
 * (`documents/{documentId}.md`) carrying the OCR/markdown extraction.
 *
 * The sidecar replaces the historical `documentProperties.markdown`
 * column. Storing it on S3 aligns the documents pipeline with the two
 * other markdown-bearing flows already on S3 — chat attachments
 * (`chatbot-sessions/{convId}/attachments/{stem}.md`) and AI context
 * files (`ai-context/{profileId}/{fileId}.md`) — and lets
 * `downloadDriveDocument` pull both binary + sidecar into the chatbot
 * sandbox in one round trip so `read('drive/{id}-{name}.pdf')`
 * auto-resolves to the markdown sidecar via the existing extension
 * routing in `@fretik/ai/src/tools/read.ts`.
 *
 * Format: flat markdown with `## Page N` headers and `---` separators
 * between pages, produced by `joinDocumentPagesMarkdown(...)` at write
 * time. Spreadsheets (xlsx/csv) get no sidecar — the vectoriser
 * already falls back to a metadata-only embedding for those.
 *
 * The original binary stays at `documents/{documentId}{ext}` (written
 * by `uploadToS3` in `lib/s3.ts`); only the sidecar belongs here.
 */

const DOCUMENTS_PREFIX = "documents";

/**
 * S3 key for the original binary. The extension comes from
 * `originalFilename` so the key carries a content-type marker.
 *
 * The `.pdf` default for extensionless filenames is a FROZEN legacy
 * constant, not a type guess: it is baked into the keys of every
 * document already stored, so changing it would strand their objects.
 * The document's real type lives in `documents.mime_type`, resolved from
 * the bytes at upload — never read a type back out of this key.
 */
export const buildDocumentOriginalKey = (
  documentId: string,
  originalFilename: string,
): string => {
  const ext = extname(originalFilename) || ".pdf";
  return `${DOCUMENTS_PREFIX}/${documentId}${ext}`;
};

/**
 * S3 key for the document thumbnail. Always `.webp` — generated via
 * `generatePdfThumbnail` / `generateImageThumbnail`, which both emit a
 * compressed WebP through Bun's native image pipeline. Documents
 * processed before the WebP switch keep a stale `.png` object whose
 * presigned URL 404s until they are reprocessed.
 */
export const buildDocumentThumbnailKey = (documentId: string): string =>
  `${DOCUMENTS_PREFIX}/${documentId}-thumbnail.webp`;

export const buildDocumentSidecarKey = (documentId: string): string =>
  `${DOCUMENTS_PREFIX}/${documentId}.md`;

/**
 * Whether a thumbnail object exists for this document — a presigned URL is
 * signed locally and says nothing about the object being there, so handing
 * one out for bytes that were never written renders a broken image where
 * the type icon belongs.
 *
 * Two conditions, both necessary: the registry must define a thumbnail
 * strategy for the type (mail, source code and SVG have none), and the
 * document must have gone through `processDocument`, which is what renders
 * it. Authored markdown never does — it is `ready` the moment it is
 * written — so it shows its icon until a re-extraction is requested.
 */
export const hasStoredThumbnail = (document: {
  status: string;
  source: string;
  mimeType: string;
  originalFilename: string;
}): boolean =>
  document.status === "ready" &&
  document.source !== "authored" &&
  thumbnailFor(document.mimeType, document.originalFilename) !== "none";

/**
 * S3 key archiving one SUPERSEDED version's bytes
 * (`documents/{documentId}/v3.pdf`).
 *
 * Only past versions live here. The newest version's `storageKey` is the LIVE
 * original key, so a document nobody ever edits stores exactly one object —
 * see the storage invariant on `documentVersions`. The nested prefix keeps
 * archives from ever colliding with the flat original / thumbnail / sidecar
 * keys above, whatever the extension.
 */
export const buildDocumentVersionKey = (
  documentId: string,
  versionNumber: number,
  originalFilename: string,
): string => {
  const ext = extname(originalFilename) || ".pdf";
  return `${DOCUMENTS_PREFIX}/${documentId}/v${versionNumber.toString()}${ext}`;
};

/**
 * Upload the OCR markdown sidecar to S3. Errors bubble up — unlike
 * the AI-context sidecar (which is best-effort because the row is
 * already persisted), this is part of the document upload critical
 * path: a missing sidecar means the vectoriser will see `null` and
 * silently fall back to metadata-only, which would degrade RAG
 * quality without any user-facing signal.
 */
export const uploadDocumentSidecar = async (
  documentId: string,
  markdown: string,
  metadata: { documentId: string; organizationId: string; teamId: string },
): Promise<void> => {
  await putObject({
    key: buildDocumentSidecarKey(documentId),
    body: new TextEncoder().encode(markdown),
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      documentId: metadata.documentId,
      organizationId: metadata.organizationId,
      teamId: metadata.teamId,
    },
  });
};

/**
 * Read the sidecar bytes back. Returns `null` on miss (spreadsheets,
 * pre-refactor rows, or a transient S3 fault — `getObjectBytes`
 * already swallows `NoSuchKey`). Callers that need to distinguish
 * "spreadsheet, no sidecar" from "fault" should consult the document
 * mime type alongside.
 */
export const getDocumentSidecarBytes = async (
  documentId: string,
): Promise<Uint8Array | null> =>
  getObjectBytes(buildDocumentSidecarKey(documentId));

/**
 * Copy the sidecar from one document id to another (used by
 * duplicate-detection: when an uploaded file's hash matches an
 * existing ready document, we clone its sidecar onto the new id
 * rather than re-running OCR). Returns silently when the source
 * has no sidecar (spreadsheets).
 */
export const copyDocumentSidecar = async (
  fromDocumentId: string,
  toDocumentId: string,
  metadata: { organizationId: string; teamId: string },
): Promise<void> => {
  const bytes = await getDocumentSidecarBytes(fromDocumentId);
  if (!bytes) return;
  await putObject({
    key: buildDocumentSidecarKey(toDocumentId),
    body: bytes,
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      documentId: toDocumentId,
      organizationId: metadata.organizationId,
      teamId: metadata.teamId,
    },
  });
};

/**
 * Delete the sidecar. Used by the documents cleanup path. Best-effort
 * (errors logged inside `deleteObject`, never re-raised — the row is
 * already gone).
 */
export const deleteDocumentSidecar = async (
  documentId: string,
): Promise<void> => {
  await deleteObject(buildDocumentSidecarKey(documentId));
};
