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
 *
 * A folder belongs to its parent's project; one created at a root belongs to
 * the project named (`projectId`), or to its team's Drive when none is. Who
 * may create it there is `authz/placement.ts`'s decision, taken before.
 */
export const createFolder = async (data: {
  name: string;
  parentFolderId: string | null | undefined;
  teamId: string;
  userId: string;
  /** The project whose root it is created at, when it has no parent. */
  projectId?: string | null;
  actor?: EventActor;
  /** What the folder is for, stated at creation — what the Drive filer
   * matches documents against. Written by a person or the assistant, so
   * the nightly generator never replaces it. */
  description?: { text: string; source: "manual" | "agent" };
}) => {
  const { name, parentFolderId, teamId, userId } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;
  const description = data.description?.text.trim()
    ? {
        description: data.description.text.trim(),
        descriptionSource: data.description.source,
        descriptionGeneratedAt: new Date(),
      }
    : {};

  // Assert parent folder + Get full path
  const parent = parentFolderId
    ? await getParentFolder(parentFolderId, teamId)
    : null;

  const fullPath = computeFolderFullPath(name, parent?.fullPath ?? null);

  const newFolder = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(folders)
      .values({
        name,
        parentFolderId,
        fullPath,
        teamId,
        projectId:
          parent === null ? (data.projectId ?? null) : parent.projectId,
        createdById: userId,
        ...description,
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
 * The parent folder's path, and the project a folder created in it joins.
 */
const getParentFolder = async (parentFolderId: string, teamId: string) => {
  const parentFolder = await db.query.folders.findFirst({
    columns: { fullPath: true, projectId: true },
    where: { id: parentFolderId, teamId },
  });

  if (!parentFolder) {
    return throwHttpError(404, {
      code: "NOT_FOUND",
      message: "Parent folder not found",
    });
  }

  return parentFolder;
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
