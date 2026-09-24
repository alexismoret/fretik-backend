import db, { type Executor } from "../../db";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * Refuse a folder id that is not one of `teamId`'s folders.
 *
 * Every write that files a document — upload, authored create, promotion from
 * a chat, a move — takes the folder from its caller. `documents` and `folders`
 * are both team-owned, but nothing at the database level stops a row of team B
 * from naming a folder of team A, and once one does, team A's folder delete
 * cascades it away (`documents.folder_id` is `ON DELETE CASCADE`). The check
 * therefore belongs to the service that writes the row, not to whichever caller
 * remembered it: `createDocumentRecord` and `updateDocument` both run it.
 *
 * `null` / `undefined` is the drive root and always allowed.
 *
 * 404, not 403: a folder of another team must be indistinguishable from one
 * that does not exist.
 *
 * Returns the folder's project — what a file filed there belongs to — or
 * null for a root, which the caller places itself.
 */
export const assertFolderInTeam = async (params: {
  folderId: string | null | undefined;
  teamId: string;
  /** Run inside the caller's transaction when it has one. */
  executor?: Executor;
}): Promise<{ readonly projectId: string | null } | null> => {
  const { folderId, teamId } = params;
  if (folderId === null || folderId === undefined) return null;

  const executor = params.executor ?? db;
  const folder = await executor.query.folders.findFirst({
    columns: { id: true, projectId: true },
    where: { id: folderId, teamId },
  });
  if (!folder) {
    return throwHttpError(404, notFound("Folder not found"));
  }
  return { projectId: folder.projectId };
};
