import { and, eq, like, sql } from "drizzle-orm";
import db from "../../db";
import { folders } from "../../db/schema";
import { internalError, notFound, throwHttpError } from "../../lib/errors";
import type { UpdateFolderInput } from "../../schemas/folders";

/**
 * Updates a folder, handling name changes, parent changes, and path updates.
 */
export const updateFolder = async (data: {
  id: string;
  teamId: string;
  updates: UpdateFolderInput;
}) => {
  const { id, teamId, updates } = data;

  // Check if folder exists
  const existingFolder = await db.query.folders.findFirst({
    where: { id, teamId },
  });

  if (!existingFolder) {
    return throwHttpError(404, notFound());
  }

  // Handle move/rename (recompute fullPath)
  let newFullPath = existingFolder.fullPath;
  const oldFullPath = existingFolder.fullPath;
  const nameChanged =
    updates.name !== undefined && updates.name !== existingFolder.name;
  const parentChanged =
    updates.parentFolderId !== undefined &&
    updates.parentFolderId !== existingFolder.parentFolderId;

  if (nameChanged || parentChanged) {
    const parentFolderId = parentChanged
      ? updates.parentFolderId
      : existingFolder.parentFolderId;

    const parentFolderFullPath = parentFolderId
      ? await getParentFolderFullPath(parentFolderId, teamId)
      : null;

    newFullPath = computeFolderFullPath(
      updates.name ?? existingFolder.name,
      parentFolderFullPath,
    );
  }

  const updatedFolder = await db.transaction(async (tx) => {
    // If parent changed, update subFolderCount
    if (parentChanged) {
      // Decrement old parent
      if (existingFolder.parentFolderId) {
        await tx
          .update(folders)
          .set({ subFolderCount: sql`${folders.subFolderCount} - 1` })
          .where(eq(folders.id, existingFolder.parentFolderId));
      }
      // Increment new parent
      if (updates.parentFolderId) {
        await tx
          .update(folders)
          .set({ subFolderCount: sql`${folders.subFolderCount} + 1` })
          .where(eq(folders.id, updates.parentFolderId));
      }
    }

    const [updated] = await tx
      .update(folders)
      .set({
        ...updates,
        fullPath: newFullPath,
      })
      .where(eq(folders.id, id))
      .returning();

    // If fullPath changed, update all sub-folders paths
    if (newFullPath !== oldFullPath) {
      await tx
        .update(folders)
        .set({
          fullPath: sql`REPLACE(${folders.fullPath}, ${oldFullPath}, ${newFullPath})`,
        })
        .where(
          and(
            like(folders.fullPath, `${oldFullPath}/%`),
            eq(folders.teamId, teamId),
          ),
        );
    }

    return updated;
  });

  if (!updatedFolder) {
    return throwHttpError(500, internalError());
  }

  return updatedFolder;
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
 * Computes the full path for a folder.
 */
const computeFolderFullPath = (
  name: string,
  parentFolderFullPath: string | null,
) => {
  return `${parentFolderFullPath ?? ""}/${name}`;
};
