import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { adapterFor } from "../../authz/access";
import type { ResourceNode } from "../../authz/rules";
import type { Executor } from "../../db";
import {
  type AiVectorSourceType,
  aiVectors,
  collectionRecords,
} from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import { hideEpisodesForRecords } from "../episodes/hide-for-source";
import { deleteEpisodeVectors } from "../episodes/vectors";

/**
 * The assistant's search index follows sharing.
 *
 * A vector row carries its team and, for a private page or workflow, its
 * owner (`team_id`, `user_id`), and search keeps the rows of the searcher's
 * team. That is right for everything that simply belongs to its team, and
 * wrong for what does not: a restricted document would be found by the whole
 * team, and a page shared with someone in another team never by them.
 *
 * So a resource whose audience is not simply its container gets its own:
 * `acl_principals`, the ids of the people, teams, projects or organization
 * that reach it at `view`, computed from the engine's nodes by the same walk
 * as `rules.ts`. Search keeps such a row when it overlaps the searcher's ids,
 * and ignores its team. Every other row keeps a NULL list and the scope it
 * always had.
 *
 * The list is written in the SAME transaction as what moves it — a grant, a
 * restriction, a move, a fresh set of vectors — never after, so there is no
 * moment when the assistant can find what its reader could not open.
 *
 * A record that MIRRORS a document (`collection_records.document_id`) is that
 * document in the collections, its name and fields: its vectors carry the
 * document's list, so the assistant never finds through the record a file it
 * could not open. And the record's activity digest — a TEAM memory — goes
 * when the team as a whole can no longer open the file.
 */

/** The resource types whose vectors can carry their own audience. */
export type AclResourceType = "document" | "page" | "workflow";

const VECTOR_SOURCE: Record<AclResourceType, AiVectorSourceType> = {
  document: "documents",
  page: "pages",
  workflow: "workflows",
};

const RESOURCE_OF: Partial<Record<AiVectorSourceType, AclResourceType>> = {
  documents: "document",
  pages: "page",
  workflows: "workflow",
};

/**
 * Who reaches a node at `view`, as ids, or null when that is exactly its
 * container — nothing restricted on the way up, nothing shared.
 *
 * The walk is `rules.ts`'s: the owner and the grants of the node, then of its
 * folder, and so on, stopping at the first restricted node; when none is,
 * the container (the top node's project, else its team) reads it too. Every
 * grant reaches `view` at least, so its principal is in the list whatever
 * its level; a team's viewers read what their team is given.
 */
export const aclOfNode = (node: ResourceNode): string[] | null => {
  const ids = new Set<string>();
  let shared = false;
  let current: ResourceNode | null = node;
  let top: ResourceNode = node;
  while (current !== null) {
    if (current.ownerUserId !== null) ids.add(current.ownerUserId);
    for (const grant of current.grants) {
      ids.add(grant.principalId);
      shared = true;
    }
    if (current.restricted) return [...ids].sort();
    top = current;
    current = current.parent;
  }
  if (!shared) return null;
  const container = top.projectId ?? top.teamId;
  if (container !== null) ids.add(container);
  return [...ids].sort();
};

/** Set the audience of one source type's vectors, for these sources. */
const writeVectorAcl = async (input: {
  executor: Executor;
  sourceType: AiVectorSourceType;
  sourceIds: readonly string[];
  acl: string[] | null;
}): Promise<void> => {
  const { acl } = input;
  for (const chunk of chunkForBulk([...input.sourceIds])) {
    // oxlint-disable-next-line no-await-in-loop -- one statement per chunk, in the caller's transaction
    await input.executor
      .update(aiVectors)
      .set({
        aclPrincipals: acl,
        // Not a content change: the refresh sweep reads `updated_at`.
        updatedAt: sql`${aiVectors.updatedAt}`,
      })
      .where(
        and(
          eq(aiVectors.sourceType, input.sourceType),
          inArray(aiVectors.sourceId, chunk),
          acl === null
            ? sql`${aiVectors.aclPrincipals} IS NOT NULL`
            : sql`${aiVectors.aclPrincipals} IS DISTINCT FROM ${sql.param(acl)}::uuid[]`,
        ),
      );
  }
};

/** Whether everyone in the node's team reads a resource with this list. */
const wholeTeamReads = (acl: string[] | null, node: ResourceNode): boolean =>
  acl === null ||
  acl.includes(node.organizationId) ||
  (node.teamId !== null && acl.includes(node.teamId));

/** The mirror record of each of these documents that has one, by document. */
const mirrorRecordsOf = async (
  executor: Executor,
  documentIds: readonly string[],
): Promise<Map<string, string>> => {
  const mirrors = new Map<string, string>();
  for (const chunk of chunkForBulk([...documentIds])) {
    // oxlint-disable-next-line no-await-in-loop -- one read per chunk, in the caller's transaction
    const rows = await executor
      .select({
        id: collectionRecords.id,
        documentId: collectionRecords.documentId,
      })
      .from(collectionRecords)
      .where(
        and(
          inArray(collectionRecords.documentId, chunk),
          isNotNull(collectionRecords.documentId),
        ),
      );
    for (const row of rows) {
      if (row.documentId !== null) mirrors.set(row.documentId, row.id);
    }
  }
  return mirrors;
};

/**
 * Rewrite the audience of these resources' vectors — and, for documents,
 * their mirror records' — reading the resources through `executor`, the
 * transaction that just changed them.
 */
export const refreshVectorAcls = async (input: {
  executor: Executor;
  type: AclResourceType;
  ids: readonly string[];
}): Promise<void> => {
  if (input.ids.length === 0) return;
  const nodes = await adapterFor(input.type).loadNodes(
    input.ids,
    input.executor,
  );

  // Most resources of a batch share one audience (a folder's documents), so
  // each distinct list is written once, for all its rows.
  const groups = new Map<string, { acl: string[] | null; ids: string[] }>();
  const keptFromTeam: string[] = [];
  for (const [id, node] of nodes) {
    const acl = aclOfNode(node);
    const key = acl === null ? "" : acl.join(",");
    const group = groups.get(key) ?? { acl, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
    if (!wholeTeamReads(acl, node)) keptFromTeam.push(id);
  }

  const mirrors =
    input.type === "document"
      ? await mirrorRecordsOf(input.executor, [...nodes.keys()])
      : new Map<string, string>();
  const privateMirrors = keptFromTeam.flatMap((id) => {
    const mirror = mirrors.get(id);
    return mirror === undefined ? [] : [mirror];
  });
  if (privateMirrors.length > 0) {
    await deleteEpisodeVectors(
      await hideEpisodesForRecords(input.executor, privateMirrors),
      input.executor,
    );
  }
  for (const { acl, ids } of groups.values()) {
    // oxlint-disable-next-line no-await-in-loop -- one audience at a time, in the caller's transaction
    await writeVectorAcl({
      executor: input.executor,
      sourceType: VECTOR_SOURCE[input.type],
      sourceIds: ids,
      acl,
    });
    const mirrorIds = ids.flatMap((id) => {
      const mirror = mirrors.get(id);
      return mirror === undefined ? [] : [mirror];
    });
    if (mirrorIds.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- same
      await writeVectorAcl({
        executor: input.executor,
        sourceType: "records",
        sourceIds: mirrorIds,
        acl,
      });
    }
  }
};

/**
 * The same, for the vectors of one source just written (`/internal/vectorize`).
 * A record's vectors take its document's audience when it mirrors one.
 */
export const refreshSourceVectorAcl = async (input: {
  executor: Executor;
  sourceType: AiVectorSourceType;
  sourceId: string;
}): Promise<void> => {
  if (input.sourceType === "records") {
    const [record] = await input.executor
      .select({ documentId: collectionRecords.documentId })
      .from(collectionRecords)
      .where(eq(collectionRecords.id, input.sourceId));
    if (record?.documentId == null) return;
    await refreshVectorAcls({
      executor: input.executor,
      type: "document",
      ids: [record.documentId],
    });
    return;
  }
  const type = RESOURCE_OF[input.sourceType];
  if (type === undefined) return;
  await refreshVectorAcls({
    executor: input.executor,
    type,
    ids: [input.sourceId],
  });
};

/** Every document at or under these folders, inside each folder's team. */
export const documentsUnderFolders = async (
  executor: Executor,
  folderIds: readonly string[],
): Promise<string[]> => {
  if (folderIds.length === 0) return [];
  const result = await executor.execute<{ id: string }>(sql`
    WITH RECURSIVE subtree AS (
      SELECT f.id, f.team_id FROM folders f
      WHERE f.id = ANY(${sql.param([...new Set(folderIds)])}::uuid[])

      UNION

      SELECT child.id, child.team_id FROM folders child
      INNER JOIN subtree s
        ON child.parent_folder_id = s.id AND child.team_id = s.team_id
    )
    SELECT d.id FROM documents d
    INNER JOIN subtree s ON d.folder_id = s.id AND d.team_id = s.team_id
  `);
  return result.rows.map((row) => row.id);
};

/**
 * After a change to who may see a Drive item, a page or a workflow: its
 * vectors, or for a folder every document below it.
 */
export const refreshAclsAfterAccessChange = async (input: {
  executor: Executor;
  type: AclResourceType | "folder" | "conversation" | "collection";
  id: string;
}): Promise<void> => {
  // A chat has no vectors of its own in the assistant's search index, and a
  // collection's records are searched in their own team only.
  if (input.type === "conversation" || input.type === "collection") return;
  if (input.type === "folder") {
    await refreshVectorAcls({
      executor: input.executor,
      type: "document",
      ids: await documentsUnderFolders(input.executor, [input.id]),
    });
    return;
  }
  await refreshVectorAcls({
    executor: input.executor,
    type: input.type,
    ids: [input.id],
  });
};
