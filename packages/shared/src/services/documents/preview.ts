import db from "../../db";
import { extensionOf, viewerFor } from "../../file-types";
import { buildSessionKey } from "../../lib/chatbot-session-storage";
import {
  buildDocumentOriginalKey,
  buildDocumentPreviewPdfKey,
  buildDocumentPreviewPdfPrefix,
  buildDocumentSidecarKey,
} from "../../lib/document-storage";
import { notFound, throwHttpError } from "../../lib/errors";
import {
  deleteObjects,
  getObjectBytes,
  getPresignedUrl,
  listObjects,
  objectExists,
  putObject,
} from "../../lib/s3";
import { convertDocumentToPdf } from "./convert";

/**
 * PDF RENDITIONS — the bytes behind the `pdf-converted` viewer strategy.
 *
 * Some formats have no browser reader and never will. Legacy Office is a
 * Compound File Binary container; OpenDocument and RTF have no JS parser
 * worth shipping; TIFF is decoded by no engine we target. What they all
 * share is that LibreOffice reads them, and that a PDF of them is a
 * faithful rendering rather than an approximation — which is what
 * separates this from showing the OCR sidecar, where the layout, the
 * tables and every image are gone.
 *
 * So the registry names them `viewer: "pdf-converted"`, the frontend asks
 * for a rendition instead of the original, and one `pdf` branch renders
 * both. No new viewer component, no new dependency: Gotenberg already
 * renders these same types for thumbnails and for OCR pre-processing.
 *
 * EVERY RENDITION BELONGS TO SOMETHING. The caller passes the key, and
 * that key always sits under the owning entity's prefix — a Drive
 * document's under `documents/{id}-preview-…`, a conversation file's
 * under that conversation's session folder. Deleting the owner therefore
 * deletes the rendition, through the paths that already exist, and the
 * bytes are attributable to a team the day we start counting them.
 *
 * A global content-addressed cache would render each distinct file once
 * instead of once per document. It is not worth it: an object keyed by
 * hash alone is owned by nobody, survives every delete, and belongs to
 * no team's quota. Renditions are derived data — recomputing one costs a
 * Gotenberg call, and losing track of one costs storage forever.
 *
 * The hash still appears INSIDE the key so that staleness cannot be
 * represented: replace a document's bytes and the rendition key changes
 * with them.
 */

/**
 * What a viewer should fetch for this file, when its own bytes are not it.
 *
 * `pdf` — a LibreOffice rendering (legacy Office, OpenDocument, RTF, TIFF).
 * `sidecar` — the markdown the extraction pipeline already produced, which
 *   is how mail is shown: `.msg` is a binary container no browser opens,
 *   and a raw `.eml` is MIME parts and quoted-printable, not a message.
 * `null` — the file renders from its own bytes.
 *
 * Derived from the registry's viewer strategy so the server and the client
 * cannot disagree about which files need this.
 */
export type PreviewSourceKind = "pdf" | "sidecar";

export const previewSourceKindFor = (
  mimeType: string,
  filename?: string,
): PreviewSourceKind | null => {
  const viewer = viewerFor(mimeType, filename);
  if (viewer === "pdf-converted") return "pdf";
  if (viewer === "email") return "sidecar";
  return null;
};

export interface PreviewSource {
  kind: PreviewSourceKind | null;
  /** Presigned and short-lived. Null when there is nothing to serve. */
  url: string | null;
}

/**
 * Presigned URL for a PDF rendition at `key`, converting on the first
 * request and serving the cached object on every one after.
 *
 * `loadBytes` is called ONLY on a miss, so the common path costs one HEAD
 * and no transfer.
 *
 * Two requests racing on a cold key both convert and both write the same
 * object to the same key. That is left alone on purpose: the write is
 * idempotent, the loser wastes one Gotenberg call, and the alternative is
 * a distributed lock guarding work measured in seconds.
 */
const renditionUrl = async (args: {
  key: string;
  /** Used for its EXTENSION: LibreOffice is told what it is being handed. */
  filename: string;
  loadBytes: () => Promise<Uint8Array | null>;
  expiresIn: number;
}): Promise<string | null> => {
  if (await objectExists(args.key)) {
    return getPresignedUrl(args.key, args.expiresIn);
  }

  const extension = extensionOf(args.filename);
  if (!extension) return null;

  const bytes = await args.loadBytes();
  if (!bytes || bytes.length === 0) return null;

  const pdf = await convertDocumentToPdf(bytes, extension);
  await putObject({ key: args.key, body: pdf, contentType: "application/pdf" });

  return getPresignedUrl(args.key, args.expiresIn);
};

/**
 * Drop this document's renditions, except the one for `keepFileHash`.
 *
 * Called when a document's bytes change: the rendition of the previous
 * content is unreachable the moment the hash moves, so it is dead weight
 * from that instant and there is no reason to carry it until the
 * document is deleted.
 *
 * By PREFIX rather than by derived key, unlike the delete paths. Those
 * can enumerate the hashes a document has held from its version rows;
 * here that set is not reliable, because `trimDocumentVersions` evicts
 * rows beyond the twentieth and takes their hashes with them. A listing
 * sees what is actually there.
 */
export const deleteStaleDocumentPreviewPdfs = async (
  documentId: string,
  keepFileHash: string,
): Promise<void> => {
  const keep = buildDocumentPreviewPdfKey(documentId, keepFileHash);
  const stale = (
    await listObjects(buildDocumentPreviewPdfPrefix(documentId))
  ).filter((key) => key !== keep);
  if (stale.length > 0) await deleteObjects(stale);
};

/**
 * The rendition of a Drive document.
 *
 * `null` rather than an error for a type that needs no rendition, or a
 * document still processing: both are ordinary answers to "is there a
 * PDF to show for this?", and the viewer has a branch for neither-yet.
 * A document that is not this team's is the one real failure, and stays
 * a 404 — the same answer an id that does not exist gets, so the route
 * cannot be used to probe another team's ids.
 */
export const getDocumentPreviewSource = async (args: {
  id: string;
  teamId: string;
  expiresIn?: number;
}): Promise<PreviewSource> => {
  const document = await db.query.documents.findFirst({
    columns: {
      id: true,
      originalFilename: true,
      mimeType: true,
      fileHash: true,
      status: true,
    },
    where: { id: args.id, teamId: args.teamId },
  });

  if (!document) return throwHttpError(404, notFound("Document not found"));

  const kind = previewSourceKindFor(
    document.mimeType,
    document.originalFilename,
  );
  if (kind === null) return { kind: null, url: null };
  if (document.status !== "ready") return { kind, url: null };

  const expiresIn = args.expiresIn ?? 3600;

  if (kind === "sidecar") {
    const key = buildDocumentSidecarKey(document.id);
    // The sidecar is written by extraction, which can have failed or not
    // run yet. Say "nothing to show" rather than hand out a URL that 404s
    // inside the viewer.
    if (!(await objectExists(key))) return { kind, url: null };
    return { kind, url: await getPresignedUrl(key, expiresIn) };
  }

  return {
    kind,
    url: await renditionUrl({
      key: buildDocumentPreviewPdfKey(document.id, document.fileHash),
      filename: document.originalFilename,
      loadBytes: () =>
        getObjectBytes(
          buildDocumentOriginalKey(document.id, document.originalFilename),
        ),
      expiresIn,
    }),
  };
};

/**
 * Session-relative path for a conversation file's rendition.
 *
 * `previews/` is neither backup-eligible nor downloadable nor listed, so
 * it is invisible to the sandbox mirror, to the workspace panel and to
 * `?path=` — and it is inside the session folder, so the conversation's
 * own delete takes it.
 */
const sessionRenditionPath = (fileHash: string): string =>
  `previews/${fileHash.slice(0, 16)}.pdf`;

/**
 * The preview source for a file in a conversation's workspace.
 *
 * `sidecarPath` is supplied by the caller rather than derived here: where a
 * conversation keeps a file's markdown is the session layout's business,
 * and this module has no view on it.
 */
export const getSessionFilePreviewSource = async (args: {
  conversationId: string;
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
  sidecarPath: string;
  expiresIn?: number;
}): Promise<PreviewSource> => {
  const kind = previewSourceKindFor(args.mimeType, args.filename);
  if (kind === null) return { kind: null, url: null };

  const expiresIn = args.expiresIn ?? 3600;

  if (kind === "sidecar") {
    const key = buildSessionKey(args.conversationId, args.sidecarPath);
    if (!(await objectExists(key))) return { kind, url: null };
    return { kind, url: await getPresignedUrl(key, expiresIn) };
  }

  return {
    kind,
    url: await renditionUrl({
      key: buildSessionKey(
        args.conversationId,
        sessionRenditionPath(Bun.SHA256.hash(args.bytes, "hex")),
      ),
      filename: args.filename,
      loadBytes: () => Promise.resolve(args.bytes),
      expiresIn,
    }),
  };
};
