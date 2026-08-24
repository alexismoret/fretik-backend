import db from "../../../db";
import { notFound, throwHttpError } from "../../../lib/errors";
import { getPresignedUrl } from "../../../lib/s3";

/**
 * A short-lived link to ONE version's bytes.
 *
 * Without it the history lists entries nobody can open — a panel that names
 * five versions and only ever hands back the current one. Restoring is not a
 * substitute: reading an old version to check what it said must not move the
 * document.
 *
 * The key is read from the ROW, never rebuilt from the version number. The
 * newest version points at the live original and older ones at their archive;
 * that split is `replace-content`'s invariant to own, and re-deriving it here
 * would be a second place to get it wrong.
 *
 * Team-scoped through the version's denormalised `teamId`, and the S3 key never
 * leaves the server — the caller gets a signed url, expiring, marked as a
 * download so the filename is right whatever the stored content type.
 */
/**
 * `report.md` → `report (v3).md`.
 *
 * The version belongs in the NAME because several of them land in the same
 * downloads folder, and a browser silently renaming the second to
 * `report (1).md` loses which is which.
 *
 * Before the extension, never after: `report.md (v3)` stops being markdown to
 * every operating system. Same reason `withNameSuffix` places its counter
 * there, and the same reason a dotfile keeps its leading dot as name.
 */
export const versionedFilename = (
  originalFilename: string,
  versionNumber: number,
): string => {
  const dot = originalFilename.lastIndexOf(".");
  const suffix = ` (v${versionNumber.toString()})`;
  return dot > 0
    ? `${originalFilename.slice(0, dot)}${suffix}${originalFilename.slice(dot)}`
    : `${originalFilename}${suffix}`;
};

export const getDocumentVersionDownloadUrl = async (args: {
  documentId: string;
  versionId: string;
  teamId: string;
  expiresInSeconds?: number;
}): Promise<{ url: string; filename: string }> => {
  const version = await db.query.documentVersions.findFirst({
    where: {
      id: args.versionId,
      documentId: args.documentId,
      teamId: args.teamId,
    },
  });
  if (!version) {
    return throwHttpError(404, notFound("Version not found"));
  }

  const document = await db.query.documents.findFirst({
    where: { id: args.documentId, teamId: args.teamId },
    columns: { originalFilename: true },
  });
  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }

  const filename = versionedFilename(
    document.originalFilename,
    version.versionNumber,
  );

  const url = await getPresignedUrl(
    version.storageKey,
    args.expiresInSeconds ?? 3600,
    { downloadFilename: filename },
  );

  return { url, filename };
};
