import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { type Executor } from "../db";
import { documents } from "../db/schema";
import { adapterFor } from "./access";
import { loadPrincipal } from "./load-principal";
import {
  type Principal,
  systemPrincipal,
  type UserPrincipal,
} from "./principal";
import type { LoadedNode } from "./resources/types";
import { containerArm, grantArm } from "./sql";

/**
 * The Drive's lists, as SQL: which folders and documents of one team a
 * person can open.
 *
 * The Drive is the one hierarchical corner of the model — a restricted folder
 * hides its whole subtree, and a folder shared with someone opens its subtree
 * to them — so the flat predicates of `sql.ts` are not enough. What a person
 * can open is computed once per list, top-down, by `rules.ts`'s own walk:
 *
 *   a folder is open when its owner is the person, a grant reaches them, or
 *   it is not restricted and inherits from something open — its parent
 *   folder, or its container (project, else team) at the root.
 *
 * Then a document is visible when its owner is the person, a grant reaches
 * them, or it is not restricted and sits in an open folder (or at the root,
 * with its container open to them). `tests/integration/authz/drive-agreement`
 * holds this to the engine's one-at-a-time answers.
 *
 * Only `view` is decided here: lists show what can be opened. What may be
 * done with an item is the engine's, per item, when it is done.
 *
 * A parent folder of ANOTHER team is bad data, never a path: the chain stays
 * inside the team, as `resources/drive.ts` reads it, and such a folder opens
 * only to its owner and its grants.
 *
 * Records that MIRROR a document (`collection_records.document_id`) read one
 * more fact: whether the document is open to its whole team
 * (`openToItsTeam`). Such a file is no one's secret, so its record follows
 * its collection's own sharing, as it always did; a file kept to some people
 * stays with them (`mirrorRecordVisible`).
 */

export interface DriveVisibility {
  /** True when nothing is hidden: a system principal. */
  readonly all: boolean;
  /** Whether the person can open this folder of the team. */
  readonly canOpenFolder: (id: string) => boolean;
  /** A folder row (its id) the person can open. */
  readonly folder: (id: AnyColumn | SQL) => SQL;
  /** A document row the person can open. */
  readonly document: (columns: DocumentColumns) => SQL;
  /**
   * A document row open to every member of its own team: not restricted, in
   * no project, and under no folder that is (`isOpenToItsTeam`).
   */
  readonly openToItsTeam: (columns: DocumentColumns) => SQL;
}

/** The document columns the predicates read, as columns or expressions. */
export interface DocumentColumns {
  id: AnyColumn | SQL;
  teamId: AnyColumn | SQL;
  projectId: AnyColumn | SQL;
  folderId: AnyColumn | SQL;
  owner: AnyColumn | SQL;
  restricted: AnyColumn | SQL;
}

const EVERYTHING: DriveVisibility = {
  all: true,
  canOpenFolder: () => true,
  folder: () => sql`true`,
  document: () => sql`true`,
  openToItsTeam: () => sql`true`,
};

const NOTHING: DriveVisibility = {
  all: false,
  canOpenFolder: () => false,
  folder: () => sql`false`,
  document: () => sql`false`,
  openToItsTeam: () => sql`false`,
};

const WRITER_FOR_NOBODY = systemPrincipal(
  "a record write for nobody in particular: a connector's sync, an import, the document pipeline",
);

/**
 * `open_folders(id)`: the team's folders the person can open, as a recursive
 * CTE a query then reads.
 */
const openFoldersCte = (principal: UserPrincipal, teamId: string): SQL => sql`
    WITH RECURSIVE open_folders AS (
      SELECT f.id FROM folders f
      WHERE f.team_id = ${teamId}
        AND (
          COALESCE(f.owner_user_id, f.created_by_id) = ${principal.userId}
          OR ${grantArm({
            principal,
            level: "view",
            resourceType: "folder",
            resourceId: sql`f.id`,
          })}
          OR (
            f.parent_folder_id IS NULL
            AND NOT f.access_restricted
            AND ${containerArm({
              principal,
              level: "view",
              teamId: sql`f.team_id`,
              projectId: sql`f.project_id`,
            })}
          )
        )

      UNION

      SELECT child.id FROM folders child
      INNER JOIN open_folders parent ON child.parent_folder_id = parent.id
      WHERE child.team_id = ${teamId} AND NOT child.access_restricted
    )`;

/** The ids of the team's folders the person can open, their whole reach. */
export const openFolderIds = async (
  principal: Principal,
  teamId: string,
  executor: Executor = db,
): Promise<string[]> => {
  if (principal.kind === "system") {
    const all = await executor.execute<{ id: string }>(
      sql`SELECT id FROM folders WHERE team_id = ${teamId}`,
    );
    return all.rows.map((row) => row.id);
  }
  const result = await executor.execute<{ id: string }>(
    sql`${openFoldersCte(principal, teamId)} SELECT id FROM open_folders`,
  );
  return result.rows.map((row) => row.id);
};

/**
 * The team's folders the person CANNOT open — the complement of
 * `openFolderIds`, and a short list, since restrictions are rare. What a
 * policy reads instead of the (long) open list: `authz/sql-tool-scope.ts`.
 */
export const hiddenFolderIds = async (
  principal: UserPrincipal,
  teamId: string,
  executor: Executor = db,
): Promise<string[]> => {
  const result = await executor.execute<{ id: string }>(sql`
    ${openFoldersCte(principal, teamId)}
    SELECT f.id FROM folders f
    WHERE f.team_id = ${teamId}
      AND NOT EXISTS (SELECT 1 FROM open_folders o WHERE o.id = f.id)
  `);
  return result.rows.map((row) => row.id);
};

/**
 * The organization's folders that are NOT open to their whole team: each
 * restricted folder and each folder of a project, with everything below it.
 * Restrictions are rare, so this is a short list.
 *
 * Conservative on purpose: a folder under a restricted one counts as closed
 * even when it is shared back with its whole team. What it hides is only the
 * mirror records of its files from teams they were never shared with; the
 * people who can open those files still see them.
 */
export const teamPrivateFolderIds = async (
  organizationId: string,
  executor: Executor = db,
): Promise<string[]> => {
  const result = await executor.execute<{ id: string }>(sql`
    WITH RECURSIVE closed AS (
      SELECT f.id, f.team_id FROM folders f
      INNER JOIN team t ON t.id = f.team_id
      WHERE t.organization_id = ${organizationId}
        AND (f.access_restricted OR f.project_id IS NOT NULL)

      UNION

      SELECT child.id, child.team_id FROM folders child
      INNER JOIN closed parent
        ON child.parent_folder_id = parent.id AND child.team_id = parent.team_id
    )
    SELECT id FROM closed
  `);
  return result.rows.map((row) => row.id);
};

/** `teamPrivateFolderIds`' rule, on one Drive node the engine loaded. */
export const isOpenToItsTeam = (node: LoadedNode): boolean => {
  for (let at: LoadedNode | null = node; at !== null; at = at.parent) {
    if (at.restricted || at.projectId !== null) return false;
  }
  return true;
};

/**
 * Which of these Drive items are open to their whole team — read BEFORE they
 * are deleted, for the journal: once an item is gone its audience can no
 * longer be looked up, so the entry that names it says whether the team could
 * read it (`teamOpen`), and only then does the team read the entry.
 */
export const teamOpenDriveItems = async (
  type: "document" | "folder",
  ids: readonly string[],
  executor: Executor = db,
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const nodes = await adapterFor(type).loadNodes(ids, executor);
  return new Set(
    [...nodes].flatMap(([id, node]) => (isOpenToItsTeam(node) ? [id] : [])),
  );
};

const uuidArray = (ids: readonly string[]): SQL =>
  sql`${sql.param([...ids])}::uuid[]`;

/**
 * The predicates of one team's Drive lists for this person. A system
 * principal sees everything — the caller's explicit, reviewed choice.
 */
export const driveVisibility = async (
  principal: Principal,
  teamId: string,
  executor: Executor = db,
): Promise<DriveVisibility> => {
  if (principal.kind === "system") return EVERYTHING;
  const [open, closedToTeams] = await Promise.all([
    openFolderIds(principal, teamId, executor),
    teamPrivateFolderIds(principal.organizationId, executor),
  ]);
  const openSet = new Set(open);
  const inOpenFolder = (id: AnyColumn | SQL): SQL =>
    open.length === 0 ? sql`false` : sql`${id} = ANY(${uuidArray(open)})`;
  const inTeamOpenFolder = (id: AnyColumn | SQL): SQL =>
    closedToTeams.length === 0
      ? sql`true`
      : sql`${id} <> ALL(${uuidArray(closedToTeams)})`;

  return {
    all: false,
    canOpenFolder: (id) => openSet.has(id),
    folder: (id) => inOpenFolder(id),
    openToItsTeam: (columns) => sql`(
      NOT ${columns.restricted}
      AND ${columns.projectId} IS NULL
      AND (${columns.folderId} IS NULL OR ${inTeamOpenFolder(columns.folderId)})
    )`,
    document: (columns) => sql`(
      ${columns.owner} = ${principal.userId}
      OR ${grantArm({
        principal,
        level: "view",
        resourceType: "document",
        resourceId: columns.id,
      })}
      OR (
        NOT ${columns.restricted}
        AND (
          (${columns.folderId} IS NULL AND ${containerArm({
            principal,
            level: "view",
            teamId: columns.teamId,
            projectId: columns.projectId,
          })})
          OR ${inOpenFolder(columns.folderId)}
        )
      )
    )`,
  };
};

/** The `documents` columns the document predicate reads, under any alias. */
export interface DocumentAccessTable {
  readonly id: AnyColumn;
  readonly teamId: AnyColumn;
  readonly projectId: AnyColumn;
  readonly folderId: AnyColumn;
  readonly ownerUserId: AnyColumn;
  readonly uploadedById: AnyColumn;
  readonly accessRestricted: AnyColumn;
}

export const documentAccessColumnsOf = (
  table: DocumentAccessTable,
): DocumentColumns => ({
  id: table.id,
  teamId: table.teamId,
  projectId: table.projectId,
  folderId: table.folderId,
  owner: sql`COALESCE(${table.ownerUserId}, ${table.uploadedById})`,
  restricted: table.accessRestricted,
});

/** The same, for the table itself (the query builder). */
export const DOCUMENT_ACCESS_COLUMNS = documentAccessColumnsOf(documents);

/** A relational-query filter on `documents`: the rows the person can open. */
export const visibleDocumentsWhere = (visibility: DriveVisibility) => ({
  RAW: (table: DocumentAccessTable) =>
    visibility.document(documentAccessColumnsOf(table)),
});

/** A relational-query filter on `folders`: the rows the person can open. */
export const visibleFoldersWhere = (visibility: DriveVisibility) => ({
  RAW: (table: { readonly id: AnyColumn }) => visibility.folder(table.id),
});

const MIRROR_DOCUMENT = "mirror_document";
const mirrorDocument = alias(documents, MIRROR_DOCUMENT);

/**
 * A document's MIRROR RECORD (`collection_records.document_id`) — its name
 * and fields in the collections — passes when the person can open the
 * document, or when the document is open to its whole team: then it is no
 * one's secret, and the record's own sharing decides, as for any record (a
 * team that shares a collection with another shares these rows too). A
 * record that mirrors no document passes.
 *
 * Every read of records applies it, so a file kept to some people never
 * surfaces through Collections, a relation, a count or a chart.
 */
export const mirrorRecordVisible = (
  visibility: DriveVisibility,
  documentId: AnyColumn | SQL,
): SQL => {
  if (visibility.all) return sql`true`;
  const columns = documentAccessColumnsOf(mirrorDocument);
  return sql`(${documentId} IS NULL OR EXISTS (
    SELECT 1 FROM ${documents} AS ${sql.identifier(MIRROR_DOCUMENT)}
    WHERE ${mirrorDocument.id} = ${documentId}
      AND (${visibility.document(columns)} OR ${visibility.openToItsTeam(columns)})
  ))`;
};

/**
 * One person's Drive visibility, by user id — for the services that know the
 * person only by id. Someone no longer in the organization opens nothing.
 */
export const driveVisibilityOfUser = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
}): Promise<DriveVisibility> => {
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  return principal ? driveVisibility(principal, input.teamId) : NOTHING;
};

/**
 * The Drive visibility of whoever a record write is for, by user id — what
 * the record services receive (`userId`). A person links only to the files
 * they can open. A write for nobody in particular (a connector's sync, an
 * import) links what its source says: who may read the result is decided
 * where it is read.
 */
export const driveVisibilityForWriter = async (input: {
  organizationId: string;
  teamId: string;
  userId?: string | null;
}): Promise<DriveVisibility> =>
  input.userId
    ? driveVisibilityOfUser({ ...input, userId: input.userId })
    : driveVisibility(WRITER_FOR_NOBODY, input.teamId);
