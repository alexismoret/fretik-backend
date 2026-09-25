import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { documents, folders } from "../../../src/db/schema";
import { listFolderDocumentIds } from "../../../src/services/folders/document-ids";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The folder scope of a knowledge search, against a real Postgres.
 *
 * Every claim is a clause a faked `db` would agree with whatever the code did:
 * that sub-folders are walked, that a folder whose NAME merely starts like
 * this one's is not (the `full_path LIKE '/A%'` trap, which also matches
 * `/AB`), that another team's documents never enter the scope even when its
 * folder hangs under this one's id, and that the limit says it was hit.
 */

let ws: WorkspaceFixture;

const createFolder = async (
  name: string,
  parentFolderId: string | null = null,
  teamId: string = ws.teamId,
): Promise<string> => {
  const [row] = await db
    .insert(folders)
    .values({ teamId, name, fullPath: `/${name}`, parentFolderId })
    .returning({ id: folders.id });
  if (!row) throw new Error("fixture: folder");
  return row.id;
};

const createDocument = async (
  folderId: string | null,
  teamId: string = ws.teamId,
): Promise<string> => {
  const [row] = await db
    .insert(documents)
    .values({
      teamId,
      folderId,
      status: "ready",
      originalFilename: `doc-${crypto.randomUUID().slice(0, 6)}.pdf`,
      fileSize: 10,
      mimeType: "application/pdf",
      fileHash: crypto.randomUUID(),
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: document");
  return row.id;
};

beforeAll(async () => {
  ws = await createWorkspaceFixture();
});

afterAll(async () => {
  await ws.cleanup();
});

describe("listFolderDocumentIds", () => {
  test("walks sub-folders, and nothing beside them", async () => {
    const a = await createFolder("A");
    const child = await createFolder("Child", a);
    const grandchild = await createFolder("Grandchild", child);
    const lookalike = await createFolder("AB");
    const inA = await createDocument(a);
    const inChild = await createDocument(child);
    const inGrandchild = await createDocument(grandchild);
    await createDocument(lookalike);
    await createDocument(null);

    const scope = await listFolderDocumentIds({
      teamId: ws.teamId,
      folderId: a,
      limit: 100,
    });

    expect(scope.found).toBe(true);
    if (!scope.found) return;
    expect([...scope.documentIds].sort()).toEqual(
      [inA, inChild, inGrandchild].sort(),
    );
    expect(scope.truncated).toBe(false);
  });

  test("another team's folder is not found, and its documents never leak in", async () => {
    const other = await ws.createTeam();
    const foreignFolder = await createFolder("Foreign", null, other.id);
    await createDocument(foreignFolder, other.id);

    expect(
      await listFolderDocumentIds({
        teamId: ws.teamId,
        folderId: foreignFolder,
        limit: 100,
      }),
    ).toEqual({ found: false });

    // A foreign row that names one of OUR folders as its parent stays out.
    const mine = await createFolder("Mine");
    const intruder = await createFolder("Intruder", mine, other.id);
    await createDocument(intruder, other.id);
    const scope = await listFolderDocumentIds({
      teamId: ws.teamId,
      folderId: mine,
      limit: 100,
    });
    expect(scope).toEqual({ found: true, documentIds: [], truncated: false });
  });

  test("says when the limit was hit", async () => {
    const big = await createFolder("Big");
    await createDocument(big);
    await createDocument(big);
    await createDocument(big);

    const scope = await listFolderDocumentIds({
      teamId: ws.teamId,
      folderId: big,
      limit: 2,
    });
    expect(scope.found && scope.truncated).toBe(true);
    expect(scope.found && scope.documentIds.length).toBe(2);
  });
});
