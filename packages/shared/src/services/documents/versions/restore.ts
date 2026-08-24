import db from "../../../db";
import type { DocumentVersion } from "../../../db/schema/documents";
import { notFound, throwHttpError } from "../../../lib/errors";
import { getObjectBytes } from "../../../lib/s3";
import type { DocumentVersionActorContext } from "./record";
import {
  replaceDocumentContent,
  type ReplaceContentResult,
} from "./replace-content";

/**
 * Roll a document back to one of its versions.
 *
 * Restoring is not a special operation — it is a replacement whose bytes come
 * from the archive instead of from the caller. So it moves history FORWARD (the
 * rollback becomes the newest version, tagged `restore`) rather than truncating
 * it: undoing a restore is just another restore, and the audit trail keeps
 * every step. Same reason it works identically for a PDF and for markdown.
 */
export const restoreDocumentVersion = async (args: {
  documentId: string;
  teamId: string;
  organizationId: string;
  versionId: string;
  actorContext: DocumentVersionActorContext;
}): Promise<ReplaceContentResult> => {
  const version: DocumentVersion | undefined =
    await db.query.documentVersions.findFirst({
      where: {
        id: args.versionId,
        documentId: args.documentId,
        teamId: args.teamId,
      },
    });
  if (!version) {
    return throwHttpError(404, notFound("Version not found"));
  }

  const bytes = await getObjectBytes(version.storageKey);
  if (!bytes) {
    return throwHttpError(
      404,
      notFound("This version's content is no longer in storage."),
    );
  }

  // `replaceDocumentContent` no-ops when the hash already matches, so
  // restoring the version you are already on changes nothing and mints no
  // history entry.
  return replaceDocumentContent({
    documentId: args.documentId,
    teamId: args.teamId,
    organizationId: args.organizationId,
    bytes,
    operation: "restore",
    actorContext: args.actorContext,
  });
};
