import { requireAccess } from "./access";
import { requireCapability } from "./gates";
import type { Principal } from "./principal";

/**
 * Adding to the Drive — an upload, a written document, a new folder, a move —
 * takes edit on the folder it lands in: 404 when that folder is out of sight,
 * 403 with the reason when it is only readable. `null` is the Drive's root,
 * which the caller's own rule covers (`team.content.create`).
 *
 * One helper for every door, the API routes and the assistant's tools alike,
 * so "where may this land" is decided once.
 */
export const requireFolderToAddTo = async (
  principal: Principal,
  folderId: string | null | undefined,
): Promise<void> => {
  if (folderId === null || folderId === undefined) return;
  await requireAccess({
    principal,
    type: "folder",
    id: folderId,
    required: "edit",
    notFoundMessage: "Folder not found",
  });
};

/** Something done to the Drive, as a door that is not a route describes it. */
export type DriveAction =
  | { kind: "createFolder"; teamId: string; parentFolderId: string | null }
  | { kind: "renameFolder"; folderId: string }
  | { kind: "moveFolder"; folderId: string; parentFolderId: string | null }
  | { kind: "deleteFolder"; folderId: string }
  | { kind: "addDocument"; teamId: string; folderId: string | null }
  | { kind: "readDocument"; documentId: string }
  | { kind: "editDocument"; documentId: string }
  | { kind: "renameDocument"; documentId: string }
  | { kind: "moveDocument"; documentId: string; folderId: string | null };

/**
 * The rules the API's Drive routes declare (`api/src/handlers/folders.ts`,
 * `documents.ts`), for the doors that are not routes: the assistant's tools,
 * and the approvals that apply them later — by which time the person may have
 * lost the access they had when the assistant asked.
 *
 *   create, upload       contribute to the team (`team.content.create`), and
 *                        edit on the destination folder
 *   rename, write        edit on the item
 *   move                 edit on the item and on where it lands
 *   delete a folder      full access: it takes everything inside with it
 *   read                 view
 *
 * 404 when the item is out of the person's sight, 403 with the reason and
 * whom to ask when it is only short of the level.
 */
export const requireDriveAction = async (
  principal: Principal,
  action: DriveAction,
): Promise<void> => {
  switch (action.kind) {
    case "createFolder":
      await requireCapability({
        principal,
        capability: "team.content.create",
        teamId: action.teamId,
      });
      await requireFolderToAddTo(principal, action.parentFolderId);
      return;
    case "addDocument":
      await requireCapability({
        principal,
        capability: "team.content.create",
        teamId: action.teamId,
      });
      await requireFolderToAddTo(principal, action.folderId);
      return;
    case "renameFolder":
      await requireFolder(principal, action.folderId, "edit");
      return;
    case "moveFolder":
      await requireFolder(principal, action.folderId, "edit");
      await requireFolderToAddTo(principal, action.parentFolderId);
      return;
    case "deleteFolder":
      await requireFolder(principal, action.folderId, "full");
      return;
    case "readDocument":
      await requireDocument(principal, action.documentId, "view");
      return;
    case "editDocument":
    case "renameDocument":
      await requireDocument(principal, action.documentId, "edit");
      return;
    case "moveDocument":
      await requireDocument(principal, action.documentId, "edit");
      await requireFolderToAddTo(principal, action.folderId);
      return;
  }
};

const requireFolder = async (
  principal: Principal,
  folderId: string,
  required: "edit" | "full",
): Promise<void> => {
  await requireAccess({
    principal,
    type: "folder",
    id: folderId,
    required,
    notFoundMessage: "Folder not found",
  });
};

const requireDocument = async (
  principal: Principal,
  documentId: string,
  required: "view" | "edit",
): Promise<void> => {
  await requireAccess({
    principal,
    type: "document",
    id: documentId,
    required,
    notFoundMessage: "Document not found",
  });
};
