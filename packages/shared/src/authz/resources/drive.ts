import { eq, inArray, sql } from "drizzle-orm";
import db, { type Executor } from "../../db";
import { documents, team } from "../../db/schema";
import type { GrantFact } from "../principal";
import { loadExplicitGrants } from "./grants";
import type { LoadedNode, ResourceAdapter } from "./types";

/**
 * The Drive: folders and documents, the one hierarchical corner of the model.
 *
 * A folder's grants reach everything below it; a restricted folder stops
 * inheriting and so hides its subtree from anyone it is not shared with. So a
 * node is never read alone: its folder chain is loaded with it, up to the
 * drive root, and linked as `parent`s for the rules to walk.
 *
 * The chain never leaves the node's team. A parent pointer into another team
 * could only be bad data (`assertFolderInTeam` refuses to write one), and
 * inheriting through it would be a path across teams nobody chose.
 *
 * Owners fall back to the historical author columns (`created_by_id`,
 * `uploaded_by_id`) for a row written before `owner_user_id` existed, or by an
 * older container during a deploy.
 */

interface FolderRow extends Record<string, unknown> {
  id: string;
  parent_folder_id: string | null;
  team_id: string;
  organization_id: string;
  project_id: string | null;
  owner_user_id: string | null;
  access_restricted: boolean;
  name: string;
}

/** The folders of `ids` and every ancestor of theirs, inside their team. */
const loadFolderChains = async (
  ids: readonly string[],
  executor: Executor,
): Promise<Map<string, FolderRow>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const result = await executor.execute<FolderRow>(sql`
    WITH RECURSIVE chain AS (
      SELECT f.id, f.parent_folder_id, f.team_id, f.project_id,
             COALESCE(f.owner_user_id, f.created_by_id) AS owner_user_id,
             f.access_restricted, f.name
      FROM folders f
      WHERE f.id = ANY(${sql.param(unique)}::uuid[])

      UNION

      SELECT p.id, p.parent_folder_id, p.team_id, p.project_id,
             COALESCE(p.owner_user_id, p.created_by_id),
             p.access_restricted, p.name
      FROM folders p
      INNER JOIN chain c ON p.id = c.parent_folder_id AND p.team_id = c.team_id
    )
    SELECT chain.*, t.organization_id
    FROM chain
    INNER JOIN team t ON t.id = chain.team_id
  `);
  return new Map(result.rows.map((row) => [row.id, row]));
};

/** Link folder rows into nodes, each with its parent chain. */
const buildFolderNodes = (
  rows: Map<string, FolderRow>,
  grants: Map<string, GrantFact[]>,
): Map<string, LoadedNode> => {
  const nodes = new Map<string, LoadedNode>();
  const build = (id: string, seen: Set<string>): LoadedNode | null => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const row = rows.get(id);
    // A cycle in the parent pointers is bad data; stop inheriting there.
    if (!row || seen.has(id)) return null;
    seen.add(id);
    const parent =
      row.parent_folder_id === null ? null : build(row.parent_folder_id, seen);
    const node: LoadedNode = {
      type: "folder",
      id: row.id,
      organizationId: row.organization_id,
      teamId: row.team_id,
      projectId: row.project_id,
      ownerUserId: row.owner_user_id,
      restricted: row.access_restricted,
      grants: grants.get(row.id) ?? [],
      parent,
      name: row.name,
    };
    nodes.set(id, node);
    return node;
  };
  for (const id of rows.keys()) build(id, new Set());
  return nodes;
};

const loadFolderNodes = async (
  ids: readonly string[],
  executor: Executor,
): Promise<Map<string, LoadedNode>> => {
  const rows = await loadFolderChains(ids, executor);
  const grants = await loadExplicitGrants("folder", [...rows.keys()], executor);
  return buildFolderNodes(rows, grants);
};

export const folderAdapter: ResourceAdapter = {
  type: "folder",
  offeredLevels: ["view", "edit", "full"],
  shareablePrincipals: ["user", "team", "project", "organization"],
  loadNodes: async (ids, executor = db) => {
    const all = await loadFolderNodes(ids, executor);
    // Only the asked-for folders go back; their ancestors ride as `parent`.
    return new Map(
      ids.flatMap((id) => {
        const node = all.get(id);
        return node ? [[id, node] as const] : [];
      }),
    );
  },
};

export const documentAdapter: ResourceAdapter = {
  type: "document",
  offeredLevels: ["view", "edit", "full"],
  shareablePrincipals: ["user", "team", "project", "organization"],
  loadNodes: async (ids, executor = db) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({
        id: documents.id,
        folderId: documents.folderId,
        teamId: documents.teamId,
        organizationId: team.organizationId,
        projectId: documents.projectId,
        ownerUserId: sql<
          string | null
        >`COALESCE(${documents.ownerUserId}, ${documents.uploadedById})`,
        restricted: documents.accessRestricted,
        name: documents.originalFilename,
      })
      .from(documents)
      .innerJoin(team, eq(team.id, documents.teamId))
      .where(inArray(documents.id, unique));

    const folderIds = rows.flatMap((row) =>
      row.folderId === null ? [] : [row.folderId],
    );
    const [folders, grants] = await Promise.all([
      loadFolderNodes(folderIds, executor),
      loadExplicitGrants(
        "document",
        rows.map((row) => row.id),
        executor,
      ),
    ]);

    return new Map(
      rows.map((row) => {
        const folder = row.folderId === null ? null : folders.get(row.folderId);
        const node: LoadedNode = {
          type: "document",
          id: row.id,
          organizationId: row.organizationId,
          teamId: row.teamId,
          projectId: row.projectId,
          ownerUserId: row.ownerUserId,
          restricted: row.restricted,
          grants: grants.get(row.id) ?? [],
          // A folder of another team is not a parent (see the file header).
          parent: folder && folder.teamId === row.teamId ? folder : null,
          name: row.name,
        };
        return [row.id, node] as const;
      }),
    );
  },
};
