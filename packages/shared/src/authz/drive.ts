import { requireAccess } from "./access";
import {
  assertProjectOpenForContent,
  projectOfTree,
  requirePlacement,
} from "./placement";
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

/**
 * Moving a Drive item: edit on it and on the folder it lands in. A move that
 * takes it into another project, or out of one, changes who reaches it the
 * way sharing does, and takes full access on it; the project it lands in must
 * take content (not archived).
 *
 * `folderId` null moves it to a root: of `projectId` when given (a project's,
 * or null for its team's), else of the place it is already in.
 */
export const requireDriveMove = async (
  principal: Principal,
  move: {
    readonly type: "folder" | "document";
    readonly id: string;
    readonly folderId: string | null | undefined;
    readonly projectId?: string | null;
  },
): Promise<void> => {
  const notFoundMessage =
    move.type === "folder" ? "Folder not found" : "Document not found";
  const { node } = await requireAccess({
    principal,
    type: move.type,
    id: move.id,
    required: "edit",
    notFoundMessage,
  });
  const from = projectOfTree(node);
  let to = move.projectId !== undefined ? move.projectId : from;
  if (move.folderId) {
    const { node: folder } = await requireAccess({
      principal,
      type: "folder",
      id: move.folderId,
      required: "edit",
      notFoundMessage: "Folder not found",
    });
    to = projectOfTree(folder);
  }
  if (to === from) return;
  await requireAccess({
    principal,
    type: move.type,
    id: move.id,
    required: "full",
    notFoundMessage,
  });
  if (to !== null) await assertProjectOpenForContent(to);
};

/** Something done to the Drive, as a door that is not a route describes it. */
export type DriveAction =
  | {
      kind: "createFolder";
      teamId: string;
      parentFolderId: string | null;
      /** The project whose root it lands at, when it has no parent. */
      projectId?: string | null;
    }
  | { kind: "renameFolder"; folderId: string }
  /** What a folder is for, which the Drive filer reads: writing it is editing the folder. */
  | { kind: "describeFolder"; folderId: string }
  | { kind: "moveFolder"; folderId: string; parentFolderId: string | null }
  | { kind: "deleteFolder"; folderId: string }
  | {
      kind: "addDocument";
      teamId: string;
      folderId: string | null;
      /** The project whose root it lands at, when it has no folder. */
      projectId?: string | null;
    }
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
 *   create, upload       where it lands (`authz/placement.ts`): edit on the
 *                        destination folder, and contributing to its team —
 *                        or taking part in the project it lands in
 *   rename, describe,    edit on the item
 *   write
 *   move                 edit on the item and on where it lands; full on
 *                        the item when it changes project (`requireDriveMove`)
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
      await requirePlacement({
        principal,
        activeTeamId: action.teamId,
        folderId: action.parentFolderId,
        projectId: action.projectId,
      });
      return;
    case "addDocument":
      await requirePlacement({
        principal,
        activeTeamId: action.teamId,
        folderId: action.folderId,
        projectId: action.projectId,
      });
      return;
    case "renameFolder":
    case "describeFolder":
      await requireFolder(principal, action.folderId, "edit");
      return;
    case "moveFolder":
      await requireDriveMove(principal, {
        type: "folder",
        id: action.folderId,
        folderId: action.parentFolderId,
      });
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
      await requireDriveMove(principal, {
        type: "document",
        id: action.documentId,
        folderId: action.folderId,
      });
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
