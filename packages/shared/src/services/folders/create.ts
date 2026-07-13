import { eq, sql } from "drizzle-orm";
import db from "../../db";
import { folders } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";

/**
 * Creates a new folder with proper path computation and parent updates.
 */
export const createFolder = async (data: {
  name: string;
  parentFolderId: string | null | undefined;
  teamId: string;
  userId: string;
  actor?: EventActor;
}) => {
  const { name, parentFolderId, teamId, userId } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;

  // Assert parent folder + Get full path
  const parentFolderFullPath = parentFolderId
    ? await getParentFolderFullPath(parentFolderId, teamId)
    : null;

  const fullPath = computeFolderFullPath(name, parentFolderFullPath);

  const newFolder = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(folders)
      .values({
        name,
        parentFolderId,
        fullPath,
        teamId,
        createdById: userId,
      })
      .returning();

    if (!inserted) {
      return throwHttpError(500, internalError());
    }

    // Increment parent's subFolderCount
    if (parentFolderId) {
      await tx
        .update(folders)
        .set({
          subFolderCount: sql`${folders.subFolderCount} + 1`,
        })
        .where(eq(folders.id, parentFolderId));
    }

    // Folders carry no org column — resolve the team's org for the journal.
    const teamRow = await tx.query.team.findFirst({
      columns: { organizationId: true },
      where: { id: teamId },
    });
    if (teamRow) {
      await emitDomainEvent({
        tx,
        organizationId: teamRow.organizationId,
        teamId,
        type: "folder.created",
        actor,
        subjectType: "folder",
        payload: { folderId: inserted.id, name },
        dedupKey: `folder.created:${inserted.id}`,
      });
    }

    return inserted;
  });

  return newFolder;
};

/**
 * Retrieves the full path of a parent folder.
 */
const getParentFolderFullPath = async (
  parentFolderId: string,
  teamId: string,
) => {
  const parentFolder = await db.query.folders.findFirst({
    columns: { fullPath: true },
    where: { id: parentFolderId, teamId },
  });

  if (!parentFolder) {
    return throwHttpError(404, {
      code: "NOT_FOUND",
      message: "Parent folder not found",
    });
  }

  return parentFolder.fullPath;
};

/**
 * Computes the full path for a new folder.
 */
const computeFolderFullPath = (
  name: string,
  parentFolderFullPath: string | null,
) => {
  return `${parentFolderFullPath ?? ""}/${name}`;
};
