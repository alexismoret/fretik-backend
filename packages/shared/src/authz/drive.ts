import { requireAccess } from "./access";
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
