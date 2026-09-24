import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { resolveAccessMany } from "../../../src/authz/access";
import type { UserPrincipal } from "../../../src/authz/principal";
import {
  sqlToolDriveScope,
  sqlToolScopeStatement,
} from "../../../src/authz/sql-tool-scope";
import db from "../../../src/db";
import { collectionGrants, domainEvents } from "../../../src/db/schema";
import { qualifiedCollectionTable } from "../../../src/services/collection-schema/identifiers";
import { reconcileCollectionTable } from "../../../src/services/collection-schema/table";
import { DOCUMENT_COLLECTION_KEY } from "../../../src/services/collections/constants";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { buildDriveTree, type DriveTree } from "../../lib/drive-tree";

/**
 * What the agent's SQL tool reads of the Drive.
 *
 * The queries run AS `fretik_sql_tool` (`SET LOCAL ROLE`), scoped by the very
 * statement `runReadonlyQuery` runs (`sqlToolScopeStatement`): the policies
 * are the only thing deciding, and a test running as the owner — which
 * bypasses RLS — would pass with any policy at all.
 *
 * The reference is the engine (`rules.ts`) on the tree of
 * `tests/lib/drive-tree.ts`: files and folders, the records that mirror the
 * files (the registry and the file collection's typed table), and the journal
 * entries that name them.
 */

let fx: WorkspaceFixture;
let tree: DriveTree;
let collectionId: string;
/** Mirror record id → the tree path of its file. */
const fileOfMirror = new Map<string, string>();

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  tree = await buildDriveTree(fx);

  // The file collection, shared with the other team: its rows that mirror a
  // file open to its whole team follow that share; the others stay with the
  // people who can open the file.
  collectionId = (await fx.createCollection({ key: DOCUMENT_COLLECTION_KEY }))
    .id;
  await reconcileCollectionTable({ collectionId });
  await db.insert(collectionGrants).values({
    organizationId: fx.organizationId,
    collectionId,
    ownerTeamId: fx.teamId,
    granteeTeamId: tree.otherTeamId,
    permission: "read",
  });
  for (const [path, documentId] of tree.documents) {
    const mirror = await fx.createRecord({
      collectionId,
      documentId,
      label: path,
    });
    fileOfMirror.set(mirror.id, path);
    await db.execute(
      sql`INSERT INTO ${sql.raw(qualifiedCollectionTable(collectionId))} (id, _team_id, _label)
          VALUES (${mirror.id}, ${fx.teamId}, ${path})`,
    );
    await db.insert(domainEvents).values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "document.uploaded",
      actorType: "user",
      actorUserId: tree.owner,
      subjectType: "document",
      subjectRecordId: mirror.id,
      payload: { documentId, filename: `${path}.pdf` },
    });
  }
});

afterAll(async () => {
  await tree.cleanup();
  await fx.cleanup();
});

/** Rows of one query, run as the SQL tool for this person in this team. */
const asSqlTool = async <T extends Record<string, unknown>>(
  principal: UserPrincipal,
  teamId: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> => {
  const scope = sqlToolScopeStatement({
    teamId,
    organizationId: fx.organizationId,
    drive: await sqlToolDriveScope(principal, teamId),
  });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE fretik_sql_tool");
    await client.query(scope.text, scope.values);
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
};

/** The tree paths of the files these mirror rows stand for. */
const filesOf = (rows: { id: string }[]): string[] =>
  rows.map((row) => fileOfMirror.get(row.id) ?? row.id).sort();

const names = (
  ids: ReadonlyMap<string, string>,
  rows: { id: string }[],
): string[] => rows.map((row) => tree.nameOf(ids, row.id)).sort();

const byEngine = async (
  principal: UserPrincipal,
  type: "folder" | "document",
  ids: ReadonlyMap<string, string>,
): Promise<string[]> =>
  [...(await resolveAccessMany(principal, type, [...ids.values()])).keys()]
    .map((id) => tree.nameOf(ids, id))
    .sort();

/** The team's people, reading in their own team. */
const teamPeople = async (): Promise<[string, UserPrincipal][]> =>
  (await tree.people()).filter(([who]) => who !== "outsider");

describe("the SQL tool reads the Drive as its reader", () => {
  test("files and folders: exactly what the engine opens to each person", async () => {
    for (const [who, principal] of await teamPeople()) {
      const files = await asSqlTool<{ id: string }>(
        principal,
        fx.teamId,
        "SELECT id FROM documents WHERE id = ANY($1)",
        [[...tree.documents.values()]],
      );
      const folderRows = await asSqlTool<{ id: string }>(
        principal,
        fx.teamId,
        "SELECT id FROM folders WHERE id = ANY($1)",
        [[...tree.folders.values()]],
      );
      expect({
        who,
        documents: names(tree.documents, files),
        folders: names(tree.folders, folderRows),
      }).toEqual({
        who,
        documents: await byEngine(principal, "document", tree.documents),
        folders: await byEngine(principal, "folder", tree.folders),
      });
    }
  });

  test("the records that mirror files, in the registry and the typed table, follow the files", async () => {
    for (const [who, principal] of await teamPeople()) {
      const registry = await asSqlTool<{ id: string }>(
        principal,
        fx.teamId,
        "SELECT id FROM collection_records WHERE collection_id = $1",
        [collectionId],
      );
      const typed = await asSqlTool<{ id: string }>(
        principal,
        fx.teamId,
        `SELECT id FROM ${qualifiedCollectionTable(collectionId)}`,
      );
      const expected = await byEngine(principal, "document", tree.documents);
      expect({
        who,
        registry: filesOf(registry),
        typed: filesOf(typed),
      }).toEqual({ who, registry: expected, typed: expected });
    }
  });

  test("another team the collection is shared with reads the mirrors of files open to their team, and of files shared with them", async () => {
    const outsider = await fx.principalOf(tree.outsider);
    const registry = await asSqlTool<{ id: string }>(
      outsider,
      tree.otherTeamId,
      "SELECT id FROM collection_records WHERE collection_id = $1",
      [collectionId],
    );
    expect(filesOf(registry)).toEqual([
      "closed/doc-for-outsider",
      "open/doc",
      "root",
      "root-restricted-org",
    ]);
  });

  test("the journal names a file only to those who can open it", async () => {
    for (const [who, principal] of await teamPeople()) {
      const entries = await asSqlTool<{ document_id: string }>(
        principal,
        fx.teamId,
        `SELECT payload->>'documentId' AS document_id FROM domain_events
         WHERE type = 'document.uploaded'`,
      );
      expect({
        who,
        files: entries
          .map((row) => tree.nameOf(tree.documents, row.document_id))
          .sort(),
      }).toEqual({
        who,
        files: await byEngine(principal, "document", tree.documents),
      });
    }
  });

  test("a deleted file's entry shows only if its whole team could open it", async () => {
    const gone = crypto.randomUUID();
    await db.insert(domainEvents).values([
      {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        type: "record.deleted",
        actorType: "user",
        actorUserId: tree.owner,
        payload: { label: "team-open", documentId: gone, teamOpen: true },
      },
      {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        type: "record.deleted",
        actorType: "user",
        actorUserId: tree.owner,
        payload: { label: "private", documentId: gone, teamOpen: false },
      },
    ]);
    const entries = await asSqlTool<{ label: string }>(
      await fx.principalOf(tree.member),
      fx.teamId,
      `SELECT payload->>'label' AS label FROM domain_events
       WHERE type = 'record.deleted' AND payload->>'documentId' = $1`,
      [gone],
    );
    expect(entries.map((row) => row.label)).toEqual(["team-open"]);
  });

  test("without the reader's scope, no file shows at all", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE fretik_sql_tool");
      await client.query(
        "SELECT set_config('fretik.team_id', $1, true), set_config('fretik.organization_id', $2, true)",
        [fx.teamId, fx.organizationId],
      );
      const files = await client.query(
        "SELECT id FROM documents WHERE id = ANY($1)",
        [[...tree.documents.values()]],
      );
      expect(files.rows).toEqual([]);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });
});
