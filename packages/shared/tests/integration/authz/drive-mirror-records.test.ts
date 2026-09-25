import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { resolveAccessMany } from "../../../src/authz/access";
import { driveVisibility } from "../../../src/authz/drive-sql";
import type { UserPrincipal } from "../../../src/authz/principal";
import db from "../../../src/db";
import { collectionGrants } from "../../../src/db/schema";
import { countRecordsForType } from "../../../src/services/collection-records/count";
import { resolveDocumentRecordIds } from "../../../src/services/collection-records/resolve-document-record";
import {
  getCollectionRecord,
  listCollectionRecords,
} from "../../../src/services/collection-records/retrieve";
import { qualifiedCollectionTable } from "../../../src/services/collection-schema/identifiers";
import { reconcileCollectionTable } from "../../../src/services/collection-schema/table";
import { listReadableRecordIds } from "../../../src/services/collection-sharing/read-access";
import { assertCanWriteRecord } from "../../../src/services/collection-sharing/write-access";
import { DOCUMENT_COLLECTION_KEY } from "../../../src/services/collections/constants";
import { bulkCreateLinks } from "../../../src/services/links/bulk-create";
import { listLinksForRecord } from "../../../src/services/links/retrieve";
import { runPageData } from "../../../src/services/pages/run-page-data";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { buildDriveTree, type DriveTree } from "../../lib/drive-tree";
import { rejection } from "../../lib/expect-rejection";

/**
 * The record that MIRRORS a file (`collection_records.document_id`) is the
 * file in the collections — its name and fields — so every read of records
 * shows it to exactly those who may see the file (`drive-sql.ts`,
 * `mirrorRecordVisible`), and a write to it takes `edit` on a file kept to
 * some people (`authz/mirror-writes.ts`).
 *
 * The reference is the engine on the tree of `tests/lib/drive-tree.ts`: each
 * of its files has a mirror, labelled with the file's path in the tree.
 */

let fx: WorkspaceFixture;
let tree: DriveTree;
let collectionId: string;
/** Mirror record ids by the tree path of their file. */
const mirrorOf = new Map<string, string>();

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  tree = await buildDriveTree(fx);
  collectionId = (await fx.createCollection({ key: DOCUMENT_COLLECTION_KEY }))
    .id;
  await reconcileCollectionTable({ collectionId });
  // Shared with the other team: the rows of files open to their whole team
  // follow the share, the others stay with the people who can open the file.
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
    mirrorOf.set(path, mirror.id);
    await db.execute(
      sql`INSERT INTO ${sql.raw(qualifiedCollectionTable(collectionId))} (id, _team_id, _label)
          VALUES (${mirror.id}, ${fx.teamId}, ${path})`,
    );
  }
});

afterAll(async () => {
  await tree.cleanup();
  await fx.cleanup();
});

const driveOf = async (userId: string, teamId = fx.teamId) =>
  driveVisibility(await fx.principalOf(userId), teamId);

/** The files the engine opens to this person, by tree path. */
const openFiles = async (principal: UserPrincipal): Promise<string[]> =>
  [
    ...(
      await resolveAccessMany(principal, "document", [
        ...tree.documents.values(),
      ])
    ).keys(),
  ]
    .map((id) => tree.nameOf(tree.documents, id))
    .sort();

const pathOfMirror = (id: string): string => tree.nameOf(mirrorOf, id);

const teamPeople = async (): Promise<[string, UserPrincipal][]> =>
  (await tree.people()).filter(([who]) => who !== "outsider");

const statusOf = async (promise: Promise<unknown>): Promise<number> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HTTPException);
  return (error as HTTPException).status;
};

describe("reading records that mirror files", () => {
  test("a list, a count and a readable-ids check show each person the mirrors of the files they can open", async () => {
    for (const [who, principal] of await teamPeople()) {
      const drive = await driveVisibility(principal, fx.teamId);
      const expected = await openFiles(principal);
      const listed = await listCollectionRecords({
        teamId: fx.teamId,
        collectionId,
        drive,
        limit: 100,
      });
      const readable = await listReadableRecordIds({
        recordIds: [...mirrorOf.values()],
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        drive,
      });
      expect({
        who,
        listed: listed.data.map((row) => pathOfMirror(row.id)).sort(),
        count: await countRecordsForType({
          collectionId,
          teamId: fx.teamId,
          drive,
        }),
        readable: [...readable].map(pathOfMirror).sort(),
      }).toEqual({
        who,
        listed: expected,
        count: expected.length,
        readable: expected,
      });
    }
  });

  test("a hidden file's mirror reads as missing by id", async () => {
    const drive = await driveOf(tree.member);
    expect(
      await statusOf(
        getCollectionRecord({
          id: mirrorOf.get("root-restricted") ?? "",
          teamId: fx.teamId,
          organizationId: fx.organizationId,
          drive,
        }),
      ),
    ).toBe(404);
    const own = await getCollectionRecord({
      id: mirrorOf.get("root-owned-by-member") ?? "",
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      drive,
    });
    expect(own.label).toBe("root-owned-by-member");
  });

  test("another team the collection is shared with sees the mirrors of files open to their team, and of files shared with them", async () => {
    const listed = await listCollectionRecords({
      teamId: tree.otherTeamId,
      collectionId,
      drive: await driveOf(tree.outsider, tree.otherTeamId),
      limit: 100,
    });
    expect(listed.data.map((row) => pathOfMirror(row.id)).sort()).toEqual([
      "closed/doc-for-outsider",
      "open/doc",
      "root",
      "root-restricted-org",
    ]);
  });

  test("a file id resolves to its mirror only for those who can open the file", async () => {
    const ids = [
      tree.documents.get("root-restricted") ?? "",
      tree.documents.get("root") ?? "",
    ];
    const resolved = await resolveDocumentRecordIds({
      documentIds: ids,
      teamId: fx.teamId,
      drive: await driveOf(tree.member),
    });
    expect([...resolved.values()].map(pathOfMirror)).toEqual(["root"]);
  });

  test("a page over the collection shows its reader the rows they may see", async () => {
    const member = await fx.principalOf(tree.member);
    const { datasets } = await runPageData({
      definition: {
        version: 3,
        variables: [],
        datasets: [{ id: "files", kind: "collections", collectionId }],
        operations: [],
        code: { source: "<template><div>files</div></template>" },
      },
      teamId: fx.teamId,
      userId: tree.member,
      reader: member,
      variables: {},
    });
    const files = datasets.files;
    expect(files?.status).toBe("ok");
    const labels =
      files?.status === "ok"
        ? files.rows
            .map((row) =>
              typeof row === "object" &&
              row !== null &&
              !Array.isArray(row) &&
              typeof row.label === "string"
                ? row.label
                : "",
            )
            .sort()
        : [];
    expect(labels).toEqual(await openFiles(member));
  });
});

describe("the graph around records that mirror files", () => {
  let other: { id: string };
  let linkTypeId: string;

  beforeAll(async () => {
    const plain = await fx.createCollection();
    other = await fx.createRecord({ collectionId: plain.id, label: "plain" });
    linkTypeId = (
      await fx.createLinkType({
        key: `about_${plain.key}`,
        fromCollectionId: plain.id,
      })
    ).id;
    await fx.createLink({
      linkTypeId,
      fromRecordId: other.id,
      toRecordId: mirrorOf.get("root-restricted") ?? "",
    });
    await fx.createLink({
      linkTypeId,
      fromRecordId: other.id,
      toRecordId: mirrorOf.get("root") ?? "",
    });
  });

  test("an edge to a hidden file's mirror is left out of a record's links", async () => {
    const links = await listLinksForRecord({
      recordId: other.id,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      drive: await driveOf(tree.member),
    });
    expect(links.outgoing.map((link) => pathOfMirror(link.toRecordId))).toEqual(
      ["root"],
    );
  });

  test("an edge to a hidden file's mirror is refused like one to a missing record", async () => {
    const result = await bulkCreateLinks({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      drive: await driveOf(tree.member),
      links: [
        {
          linkTypeId,
          fromRecordId: other.id,
          toRecordId: mirrorOf.get("open/closed/doc") ?? "",
        },
      ],
    });
    expect(result.errors).toEqual([{ index: 0, error: "Record not found." }]);
  });
});

describe("writing records that mirror files", () => {
  const write = (path: string, userId: string) =>
    assertCanWriteRecord({
      recordId: mirrorOf.get(path) ?? "",
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId,
    });

  test("a file open to the whole team: the team's contributors write its record", async () => {
    await write("root", tree.member);
    await write("open/doc", tree.member);
  });

  test("a file the writer cannot open: its record reads as missing", async () => {
    expect(await statusOf(write("root-restricted", tree.member))).toBe(404);
  });

  test("a file the writer may only view: 403, naming the file", async () => {
    const error = await rejection(
      write("open/shared-with-member/doc", tree.member),
    );
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(403);
  });

  test("a file the writer may edit, kept from the rest of the team: allowed", async () => {
    await write("closed/team/doc", tree.member);
    await write("root-owned-by-member", tree.member);
  });
});
