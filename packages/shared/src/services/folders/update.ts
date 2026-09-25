import { eq, sql } from "drizzle-orm";
import db from "../../db";
import { folders } from "../../db/schema";
import {
  badRequest,
  internalError,
  notFound,
  throwHttpError,
} from "../../lib/errors";
import type { UpdateFolderInput } from "../../schemas/folders";
import { refreshAclsAfterAccessChange } from "../ai-vectors/acl";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { relocateFolderTree } from "./relocate";
import { listFolderSubtreeIds } from "./subtree";

/**
 * Updates a folder, handling name changes, parent changes, and path updates.
 *
 * A folder belongs to its tree's project, and so does everything in it: a
 * move into another project's folder, or to a root of another place
 * (`projectId`), takes the whole subtree with it — every folder and file
 * below carries the project the Drive's lists read. Who may move it there,
 * and whether crossing into or out of a project takes full access, is the
 * caller's gate (`authz/drive.ts`, `requireDriveMove`).
 */
export const updateFolder = async (data: {
  id: string;
  teamId: string;
  updates: UpdateFolderInput;
  /**
   * The project whose root the folder moves to, when it moves to a root: a
   * project's, or null for its team's. Omitted, a folder moved to a root
   * stays in its own place (the root of its project, or its team's).
   */
  projectId?: string | null;
  actor?: EventActor;
  /** Who is writing `updates.description`: a person (default) or the
   * assistant. Either way the generator leaves it alone afterwards. */
  descriptionSource?: "manual" | "agent";
}) => {
  const { id, teamId, updates } = data;
  const actor = data.actor ?? SYSTEM_ACTOR;

  // Check if folder exists
  const existingFolder = await db.query.folders.findFirst({
    where: { id, teamId },
  });

  if (!existingFolder) {
    return throwHttpError(404, notFound());
  }

  const oldFullPath = existingFolder.fullPath;
  const nameChanged =
    updates.name !== undefined && updates.name !== existingFolder.name;
  const parentChanged =
    updates.parentFolderId !== undefined &&
    updates.parentFolderId !== existingFolder.parentFolderId;
  const parentFolderId = parentChanged
    ? (updates.parentFolderId ?? null)
    : existingFolder.parentFolderId;

  // Its parent is read only when its path or its place may change.
  const parent =
    parentFolderId !== null && (nameChanged || parentChanged)
      ? await getParentFolder(parentFolderId, teamId)
      : null;
  // The place it lands in: its new parent's project, or at a root the one
  // named — else where it already is.
  const projectId =
    parentFolderId !== null
      ? parentChanged && parent !== null
        ? parent.projectId
        : existingFolder.projectId
      : data.projectId !== undefined
        ? data.projectId
        : existingFolder.projectId;
  const projectChanged = projectId !== existingFolder.projectId;
  const moved = parentChanged || projectChanged;

  const newFullPath =
    nameChanged || parentChanged
      ? computeFolderFullPath(
          updates.name ?? existingFolder.name,
          parent?.fullPath ?? null,
        )
      : oldFullPath;

  const updatedFolder = await db.transaction(async (tx) => {
    // A folder moved into itself, or under one of its own folders, would
    // leave its whole tree hanging from nothing.
    if (parentChanged && parentFolderId !== null) {
      const subtree = await listFolderSubtreeIds({
        rootIds: [id],
        teamId,
        executor: tx,
      });
      if (subtree.includes(parentFolderId)) {
        return throwHttpError(
          400,
          badRequest(
            "A folder cannot be moved into itself or one of its folders.",
          ),
        );
      }
    }

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
      if (parentFolderId) {
        await tx
          .update(folders)
          .set({ subFolderCount: sql`${folders.subFolderCount} + 1` })
          .where(eq(folders.id, parentFolderId));
      }
    }

    // A description the user typed is MANUAL from then on, and the nightly
    // generator skips manual folders for good — their statement of where
    // things should go outranks anything inferred from what is already
    // inside. Clearing it back to empty hands the folder back to the
    // generator rather than pinning it blank, which is what someone deleting
    // the text means.
    const { description, ...rest } = updates;
    const descriptionPatch =
      description === undefined
        ? {}
        : description === null || description.trim().length === 0
          ? {
              description: null,
              descriptionSource: null,
              descriptionGeneratedAt: null,
              descriptionDocumentCount: null,
            }
          : {
              description: description.trim(),
              descriptionSource: data.descriptionSource ?? "manual",
              descriptionGeneratedAt: new Date(),
              descriptionDocumentCount: null,
            };

    const [updated] = await tx
      .update(folders)
      .set({
        ...rest,
        ...descriptionPatch,
        fullPath: newFullPath,
        ...(projectChanged ? { projectId } : {}),
      })
      .where(eq(folders.id, id))
      .returning();

    // Everything below follows: its paths, and the place it now belongs to.
    if (updated && (newFullPath !== oldFullPath || projectChanged)) {
      await relocateFolderTree(tx, {
        folderId: id,
        teamId,
        oldFullPath,
        newFullPath,
        ...(projectChanged ? { projectId } : {}),
      });
    }

    // Moved: the folder and everything below it now inherit from another
    // parent or another place, so the assistant's search follows them there
    // (`acl.ts`).
    if (moved && updated) {
      await refreshAclsAfterAccessChange({ executor: tx, type: "folder", id });
    }

    if (updated) {
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
          type: "folder.renamed",
          actor,
          subjectType: "folder",
          payload: {
            folderId: id,
            name: updated.name,
            changed: Object.keys(updates).filter(
              (k) => updates[k as keyof typeof updates] !== undefined,
            ),
          },
        });
      }
    }

    return updated;
  });

  if (!updatedFolder) {
    return throwHttpError(500, internalError());
  }

  return updatedFolder;
};

/**
 * The new parent's path, and the project a folder moved into it joins.
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
 * Computes the full path for a folder.
 */
const computeFolderFullPath = (
  name: string,
  parentFolderFullPath: string | null,
) => {
  return `${parentFolderFullPath ?? ""}/${name}`;
};
