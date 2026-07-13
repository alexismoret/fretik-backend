import db from "../../db";

/**
 * Lean listing of a folder's direct sub-folders, scoped to a team.
 *
 * `parentFolderId = null` (or omitted) lists the drive root. Returns only
 * what a caller needs to navigate the tree or pick a folder id — no
 * documents, thumbnails, or presigned URLs (that is `getFolderExplorer`'s
 * job). Used by the AI `listFolders` tool so the agent can discover folder
 * ids for rename / move / delete, including empty folders that never surface
 * through `searchDocuments`.
 */
export const listFolders = async (data: {
  teamId: string;
  parentFolderId?: string | null;
}) => {
  const { teamId, parentFolderId } = data;

  return db.query.folders.findMany({
    columns: {
      id: true,
      name: true,
      parentFolderId: true,
      subFolderCount: true,
      documentCount: true,
    },
    where: {
      teamId,
      parentFolderId: parentFolderId ? parentFolderId : { isNull: true },
    },
    orderBy: { name: "asc" },
  });
};
