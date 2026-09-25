import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, inArray } from "drizzle-orm";
import { resolveAccessMany } from "../../../src/authz/access";
import {
  DOCUMENT_ACCESS_COLUMNS,
  driveVisibility,
} from "../../../src/authz/drive-sql";
import type { UserPrincipal } from "../../../src/authz/principal";
import db from "../../../src/db";
import { documents, folders } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { buildDriveTree, type DriveTree } from "../../lib/drive-tree";

/**
 * The Drive's list predicates (`authz/drive-sql.ts`) agree with the rules
 * (`rules.ts`, through `resolveAccessMany`) on a tree built to disagree
 * (`tests/lib/drive-tree.ts`).
 */

let fx: WorkspaceFixture;
let tree: DriveTree;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  tree = await buildDriveTree(fx);
});

afterAll(async () => {
  await tree.cleanup();
  await fx.cleanup();
});

const byEngine = async (
  principal: UserPrincipal,
  type: "folder" | "document",
  ids: ReadonlyMap<string, string>,
): Promise<string[]> =>
  [...(await resolveAccessMany(principal, type, [...ids.values()])).keys()]
    .map((id) => tree.nameOf(ids, id))
    .sort();

const bySql = async (
  principal: UserPrincipal,
): Promise<{ folders: string[]; documents: string[] }> => {
  const visible = await driveVisibility(principal, fx.teamId);
  const folderRows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        inArray(folders.id, [...tree.folders.values()]),
        visible.folder(folders.id),
      ),
    );
  const documentRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        inArray(documents.id, [...tree.documents.values()]),
        visible.document(DOCUMENT_ACCESS_COLUMNS),
      ),
    );
  return {
    folders: folderRows.map((row) => tree.nameOf(tree.folders, row.id)).sort(),
    documents: documentRows
      .map((row) => tree.nameOf(tree.documents, row.id))
      .sort(),
  };
};

describe("the Drive's list predicates agree with the rules", () => {
  test("every person sees exactly the folders and documents they can open", async () => {
    for (const [who, principal] of await tree.people()) {
      const expected = {
        folders: await byEngine(principal, "folder", tree.folders),
        documents: await byEngine(principal, "document", tree.documents),
      };
      expect({ who, ...(await bySql(principal)) }).toEqual({
        who,
        ...expected,
      });
    }
  });
});

describe("anchors — what the agreement is about", () => {
  test("a restricted folder hides its subtree from the team", async () => {
    const listed = await bySql(await fx.principalOf(tree.member));
    expect(listed.folders).not.toContain("open/closed/sub");
    expect(listed.documents).not.toContain("open/closed/sub/doc");
  });

  test("a folder shared with the team inside a closed one opens to the team", async () => {
    const listed = await bySql(await fx.principalOf(tree.viewer));
    expect(listed.folders).toContain("closed/team");
    expect(listed.documents).toContain("closed/team/doc");
    expect(listed.folders).not.toContain("closed");
  });

  test("someone from another team reaches the one document shared with them", async () => {
    const listed = await bySql(await fx.principalOf(tree.outsider));
    expect(listed).toEqual({
      folders: [],
      documents: ["closed/doc-for-outsider", "root-restricted-org"],
    });
  });

  test("an expired grant opens nothing", async () => {
    const listed = await bySql(await fx.principalOf(tree.member));
    expect(listed.folders).not.toContain("closed/expired");
  });
});
