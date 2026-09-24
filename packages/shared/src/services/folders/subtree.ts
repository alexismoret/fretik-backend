import { sql } from "drizzle-orm";
import type { Executor } from "../../db";

/**
 * The ids of `rootIds` and of every folder below them, walked through
 * `parent_folder_id` INSIDE one team.
 *
 * Why the parent pointers and not `full_path`: the path is a display string,
 * not an identity. It is `/<name>` for a root folder, so it repeats across
 * every team and every organization, it has no boundary (`/Invoices` is a
 * prefix of `/Invoices-old`), and a `%` or `_` in a folder name is a LIKE
 * wildcard. A `full_path LIKE '/Invoices%'` sweep once selected the documents
 * of every tenant's "Invoices" folder and deleted their bytes from S3. The
 * parent pointer names exactly one folder, and every step of the walk is
 * pinned to the team, so the result cannot leave it whatever the data says.
 *
 * Roots that are not the team's are dropped silently — callers that must
 * refuse them (a delete of ids the caller named) check existence first.
 */
export const listFolderSubtreeIds = async (params: {
  rootIds: string[];
  teamId: string;
  executor: Executor;
}): Promise<string[]> => {
  const { rootIds, teamId, executor } = params;
  if (rootIds.length === 0) return [];

  const result = await executor.execute<{ id: string }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT id
      FROM folders
      WHERE id = ANY(${sql.param(rootIds)}::uuid[]) AND team_id = ${teamId}

      UNION

      SELECT child.id
      FROM folders child
      INNER JOIN subtree parent ON child.parent_folder_id = parent.id
      WHERE child.team_id = ${teamId}
    )
    SELECT id FROM subtree
  `);

  return result.rows.map((row) => row.id);
};
