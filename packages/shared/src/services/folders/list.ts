import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  documentAccessColumnsOf,
  driveVisibility,
} from "../../authz/drive-sql";
import type { Principal } from "../../authz/principal";
import db from "../../db";
import { documents, folders } from "../../db/schema";

/**
 * Lean listing of a folder's direct sub-folders the person can open, scoped
 * to a team, each with what it holds that they can open too — the folders'
 * stored counters count what the person may not see.
 *
 * `parentFolderId = null` (or omitted) lists the drive root. Returns only
 * what a caller needs to navigate the tree or pick a folder id — no
 * documents, thumbnails, or presigned URLs (that is `getFolderExplorer`'s
 * job). Used by the AI `listFolders` tool so the agent can discover folder
 * ids for rename / move / delete, including empty folders that never surface
 * through `searchDocuments`.
 */
export const listFolders = async (data: {
  principal: Principal;
  teamId: string;
  parentFolderId?: string | null;
}) => {
  const { principal, teamId, parentFolderId } = data;
  const visibility = await driveVisibility(principal, teamId);
  const child = alias(folders, "child");
  const doc = alias(documents, "doc");

  return db
    .select({
      id: folders.id,
      name: folders.name,
      parentFolderId: folders.parentFolderId,
      subFolderCount: sql<number>`(
        SELECT count(*) FROM ${child}
        WHERE ${child.parentFolderId} = ${folders.id}
          AND ${visibility.folder(child.id)}
      )`.mapWith(Number),
      documentCount: sql<number>`(
        SELECT count(*) FROM ${doc}
        WHERE ${doc.folderId} = ${folders.id}
          AND ${doc.status} <> 'error'
          AND ${visibility.document(documentAccessColumnsOf(doc))}
      )`.mapWith(Number),
    })
    .from(folders)
    .where(
      and(
        eq(folders.teamId, teamId),
        parentFolderId
          ? eq(folders.parentFolderId, parentFolderId)
          : isNull(folders.parentFolderId),
        visibility.folder(folders.id),
      ),
    )
    .orderBy(asc(folders.name));
};
