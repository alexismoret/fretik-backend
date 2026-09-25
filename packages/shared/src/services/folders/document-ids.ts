import { sql } from "drizzle-orm";
import db from "../../db";

export type FolderDocumentIds =
  { found: false } | { found: true; documentIds: string[]; truncated: boolean };

/**
 * The ids of every document in a folder AND its sub-folders, team-scoped.
 *
 * What a search "inside this folder" filters on. Resolved at query time from
 * `documents.folder_id`, deliberately NOT stored on the vectors: a folder is
 * where a document sits today, it changes on every move (and for a whole
 * subtree when a parent moves), and copying it onto each chunk would mean
 * rewriting those chunks every time, or searching a stale Drive.
 *
 * Walked by parent id (a recursive CTE), not by `full_path` prefix: `/A` is a
 * prefix of `/AB`, and a name may carry `%` or `_`. `limit` bounds the list a
 * caller will put in an `IN (…)`; `truncated` says it was hit.
 */
export const listFolderDocumentIds = async (params: {
  teamId: string;
  folderId: string;
  limit: number;
}): Promise<FolderDocumentIds> => {
  const { teamId, folderId, limit } = params;
  const folder = await db.query.folders.findFirst({
    columns: { id: true },
    where: { id: folderId, teamId },
  });
  if (!folder) return { found: false };

  const rows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM folders WHERE id = ${folderId}::uuid AND team_id = ${teamId}::uuid
      UNION
      SELECT f.id FROM folders f
      JOIN subtree s ON f.parent_folder_id = s.id
      WHERE f.team_id = ${teamId}::uuid
    )
    SELECT d.id FROM documents d
    WHERE d.team_id = ${teamId}::uuid
      AND d.folder_id IN (SELECT id FROM subtree)
    ORDER BY d.id
    LIMIT ${limit + 1}
  `);
  const ids = rows.rows.map((r) => r.id);
  return {
    found: true,
    documentIds: ids.slice(0, limit),
    truncated: ids.length > limit,
  };
};
