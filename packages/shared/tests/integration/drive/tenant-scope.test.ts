import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * The Drive's tenant boundary on its destructive paths.
 *
 * Every write here takes ids from a request, and the team is the only thing
 * that says whose they are. Three shapes were broken and each test below pins
 * one down with rows that differ from a legitimate one in EXACTLY ONE COLUMN —
 * the team — so a refusal can only come from the team predicate:
 *
 *   - a folder delete swept documents by `full_path LIKE '<path>%'`, which
 *     matched every tenant's folder of the same name (and `/Invoices-old`);
 *   - a document delete authorized on a team-filtered read, then deleted by
 *     the caller's raw ids;
 *   - a document could be filed into another team's folder, whose delete then
 *     cascaded it away.
 */

// S3 is the process boundary: record what would be deleted instead of calling
// out. Installed before the subjects are imported (static imports hoist).
const deletedKeys: string[] = [];
await mockModule("../../../src/lib/s3", {
  deleteFilesFromS3: async (keys: string[]): Promise<void> => {
    deletedKeys.push(...keys);
  },
});

const { default: db } = await import("../../../src/db");
const { documents, folders } = await import("../../../src/db/schema");
const { deleteFolders } = await import("../../../src/services/folders/delete");
const { deleteDocuments } =
  await import("../../../src/services/documents/delete");
const { createDocumentRecord } =
  await import("../../../src/services/documents/upload");
const { updateDocument } =
  await import("../../../src/services/documents/update");
const { getUploadProgress } =
  await import("../../../src/services/documents/progress");
const { createWorkspaceFixture } = await import("../../lib/db-fixtures");

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

let fx: Fixture;
let otherTeamId: string;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  otherTeamId = (await fx.createTeam()).id;
});

afterAll(async () => {
  await fx.cleanup();
});

const insertFolder = async (params: {
  teamId: string;
  name: string;
  parentFolderId?: string;
  parentPath?: string;
}): Promise<string> => {
  const [row] = await db
    .insert(folders)
    .values({
      teamId: params.teamId,
      name: params.name,
      parentFolderId: params.parentFolderId ?? null,
      fullPath: `${params.parentPath ?? ""}/${params.name}`,
    })
    .returning({ id: folders.id });
  if (!row) throw new Error("fixture: no folder");
  return row.id;
};

const insertDocument = async (params: {
  teamId: string;
  folderId: string | null;
}): Promise<string> => {
  const [row] = await db
    .insert(documents)
    .values({
      teamId: params.teamId,
      folderId: params.folderId,
      status: "ready",
      originalFilename: `file-${randomUUID().slice(0, 8)}.pdf`,
      fileSize: 1024,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: no document");
  return row.id;
};

const documentExists = async (id: string): Promise<boolean> =>
  (await db.query.documents.findFirst({
    columns: { id: true },
    where: { id },
  })) !== undefined;

const keysMention = (id: string): boolean =>
  deletedKeys.some((key) => key.includes(id));

/** A foreign id must read as absent: 404, never 403. */
const expectNotFound = async (promise: Promise<unknown>): Promise<void> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HTTPException);
  expect((error as HTTPException).status).toBe(404);
};

describe("deleteFolders stays inside the team", () => {
  test("a same-named folder of another team keeps its documents and bytes", async () => {
    deletedKeys.length = 0;
    const suffix = randomUUID().slice(0, 8);
    const name = `Invoices-${suffix}`;

    const mine = await insertFolder({ teamId: fx.teamId, name });
    const myDocument = await insertDocument({
      teamId: fx.teamId,
      folderId: mine,
    });
    // Another team, the SAME path — the row the old `LIKE` sweep matched.
    const theirs = await insertFolder({ teamId: otherTeamId, name });
    const theirDocument = await insertDocument({
      teamId: otherTeamId,
      folderId: theirs,
    });

    await deleteFolders({ ids: [mine], teamId: fx.teamId });

    expect(await documentExists(myDocument)).toBe(false);
    expect(keysMention(myDocument)).toBe(true);
    expect(await documentExists(theirDocument)).toBe(true);
    expect(keysMention(theirDocument)).toBe(false);
  });

  test("a sibling whose name starts with the deleted one is not a descendant", async () => {
    deletedKeys.length = 0;
    const name = `Reports-${randomUUID().slice(0, 8)}`;

    const deleted = await insertFolder({ teamId: fx.teamId, name });
    // Same team, `/Reports-x-old`: a prefix match with no `/` boundary.
    const sibling = await insertFolder({
      teamId: fx.teamId,
      name: `${name}-old`,
    });
    const siblingDocument = await insertDocument({
      teamId: fx.teamId,
      folderId: sibling,
    });

    await deleteFolders({ ids: [deleted], teamId: fx.teamId });

    expect(await documentExists(siblingDocument)).toBe(true);
    expect(keysMention(siblingDocument)).toBe(false);
  });

  test("documents of subfolders go with the folder", async () => {
    deletedKeys.length = 0;
    const name = `Archive-${randomUUID().slice(0, 8)}`;
    const root = await insertFolder({ teamId: fx.teamId, name });
    const child = await insertFolder({
      teamId: fx.teamId,
      name: "2026",
      parentFolderId: root,
      parentPath: `/${name}`,
    });
    const nested = await insertDocument({ teamId: fx.teamId, folderId: child });

    await deleteFolders({ ids: [root], teamId: fx.teamId });

    expect(await documentExists(nested)).toBe(false);
    expect(keysMention(nested)).toBe(true);
  });

  test("another team's document filed in the folder survives, at its root", async () => {
    deletedKeys.length = 0;
    const folder = await insertFolder({
      teamId: fx.teamId,
      name: `Shared-${randomUUID().slice(0, 8)}`,
    });
    // Written before `assertFolderInTeam` existed: a row of the other team
    // naming this team's folder. The FK cascade would have taken it.
    const stray = await insertDocument({
      teamId: otherTeamId,
      folderId: folder,
    });

    await deleteFolders({ ids: [folder], teamId: fx.teamId });

    const row = await db.query.documents.findFirst({
      columns: { folderId: true },
      where: { id: stray },
    });
    expect(row).toEqual({ folderId: null });
    expect(keysMention(stray)).toBe(false);
  });
});

describe("deleteDocuments deletes only the team's documents", () => {
  test("an id of another team in the list is skipped", async () => {
    deletedKeys.length = 0;
    const mine = await insertDocument({ teamId: fx.teamId, folderId: null });
    const theirs = await insertDocument({
      teamId: otherTeamId,
      folderId: null,
    });

    const result = await deleteDocuments({
      ids: [mine, theirs],
      teamId: fx.teamId,
    });

    expect(result.rowCount).toBe(1);
    expect(await documentExists(mine)).toBe(false);
    expect(await documentExists(theirs)).toBe(true);
    expect(keysMention(theirs)).toBe(false);
  });
});

describe("a document can only be filed into the team's own folders", () => {
  test("creating a document in another team's folder is refused", async () => {
    const theirFolder = await insertFolder({
      teamId: otherTeamId,
      name: `Theirs-${randomUUID().slice(0, 8)}`,
    });

    await expectNotFound(
      createDocumentRecord({
        metadata: {
          id: randomUUID(),
          folderId: theirFolder,
          originalFilename: "intruder.pdf",
          fileSize: 10,
          mimeType: "application/pdf",
          fileHash: randomUUID(),
        },
        teamId: fx.teamId,
        userId: fx.userIds[0],
      }),
    );

    const folder = await db.query.folders.findFirst({
      columns: { documentCount: true },
      where: { id: theirFolder },
    });
    expect(folder?.documentCount).toBe(0);
  });

  test("moving a document into another team's folder is refused", async () => {
    const theirFolder = await insertFolder({
      teamId: otherTeamId,
      name: `Target-${randomUUID().slice(0, 8)}`,
    });
    const mine = await insertDocument({ teamId: fx.teamId, folderId: null });

    await expectNotFound(
      updateDocument({
        id: mine,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        updates: { folderId: theirFolder },
      }),
    );

    const row = await db.query.documents.findFirst({
      columns: { folderId: true },
      where: { id: mine },
    });
    expect(row).toEqual({ folderId: null });
  });

  test("an update that does not name a folder does not touch folder counts", async () => {
    const folder = await insertFolder({
      teamId: fx.teamId,
      name: `Counted-${randomUUID().slice(0, 8)}`,
    });
    await db
      .update(folders)
      .set({ documentCount: 1 })
      .where(eq(folders.id, folder));
    const mine = await insertDocument({ teamId: fx.teamId, folderId: folder });

    await updateDocument({
      id: mine,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      updates: { originalFilename: "renamed" },
    });

    const row = await db.query.folders.findFirst({
      columns: { documentCount: true },
      where: { id: folder },
    });
    expect(row?.documentCount).toBe(1);
  });
});

describe("upload progress is readable only by the owning team", () => {
  test("another team's document reads as absent", async () => {
    const theirs = await insertDocument({
      teamId: otherTeamId,
      folderId: null,
    });

    expect(
      await getUploadProgress({ documentId: theirs, teamId: fx.teamId }),
    ).toBeUndefined();
    expect(
      await getUploadProgress({ documentId: theirs, teamId: otherTeamId }),
    ).toEqual({ status: "ready", errorMessage: null });
  });
});
