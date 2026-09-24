import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Executor } from "../../db";
import { documents, folders } from "../../db/schema";
import { listFolderSubtreeIds } from "./subtree";

/**
 * What moving a folder does to everything below it, inside the caller's
 * transaction: the paths of its folders, and the place they all belong to.
 *
 *   paths    every folder under it takes the moved folder's new path as its
 *            prefix. By id, never by matching the old path as a pattern: a
 *            path is a display string, and a `LIKE` on it reaches folders
 *            that only look alike (`subtree.ts`).
 *   project  every folder and file of the tree carries its root's project,
 *            which is what the Drive's lists read; a move into another place
 *            takes the whole tree there.
 *
 * Returns the subtree's folder ids, the moved folder included.
 */
export const relocateFolderTree = async (
  tx: Executor,
  input: {
    readonly folderId: string;
    readonly teamId: string;
    readonly oldFullPath: string;
    readonly newFullPath: string;
    /** The project the tree now belongs to; undefined when it stays put. */
    readonly projectId?: string | null;
  },
): Promise<string[]> => {
  const { folderId, teamId, oldFullPath, newFullPath } = input;
  const subtree = await listFolderSubtreeIds({
    rootIds: [folderId],
    teamId,
    executor: tx,
  });

  if (newFullPath !== oldFullPath) {
    await tx
      .update(folders)
      .set({
        fullPath: sql`${newFullPath}::text || substring(${folders.fullPath} from ${oldFullPath.length + 1}::int)`,
      })
      .where(
        and(
          inArray(folders.id, subtree),
          ne(folders.id, folderId),
          eq(folders.teamId, teamId),
        ),
      );
  }

  if (input.projectId !== undefined) {
    await tx
      .update(folders)
      .set({ projectId: input.projectId })
      .where(and(inArray(folders.id, subtree), eq(folders.teamId, teamId)));
    await tx
      .update(documents)
      .set({ projectId: input.projectId })
      .where(
        and(inArray(documents.folderId, subtree), eq(documents.teamId, teamId)),
      );
  }

  return subtree;
};
