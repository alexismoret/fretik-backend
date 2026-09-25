import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import db from "../../../src/db";
import { decisionLog, documents, folders } from "../../../src/db/schema";
import { recordDecisions } from "../../../src/services/decisions/journal";
import { moveDocuments } from "../../../src/services/documents/move";
import { moveFolders } from "../../../src/services/folders/move";
import { updateFolder } from "../../../src/services/folders/update";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * Batch moves in the Drive, against a real Postgres.
 *
 * What the agent's `manageDrive` batch rests on, every claim a WHERE clause or
 * a counter a faked `db` would agree with whatever the code did: that the
 * folder counters match what actually moved (they order the filing candidates
 * and gate the nightly describe pass), that another team's document is refused
 * rather than moved, that one stale id costs its own row and not the batch,
 * and that a folder cannot be moved inside itself, which used to cut its
 * whole branch off the tree.
 */

let ws: WorkspaceFixture;

const createFolder = async (
  name: string,
  parent: { id: string; fullPath: string } | null = null,
  teamId: string = ws.teamId,
): Promise<{ id: string; fullPath: string }> => {
  const fullPath = `${parent?.fullPath ?? ""}/${name}`;
  const [row] = await db
    .insert(folders)
    .values({ teamId, name, fullPath, parentFolderId: parent?.id ?? null })
    .returning({ id: folders.id, fullPath: folders.fullPath });
  if (!row) throw new Error("fixture: folder");
  if (parent) {
    await db
      .update(folders)
      .set({ subFolderCount: 1 })
      .where(eq(folders.id, parent.id));
  }
  return row;
};

/** Documents in `folderId`, with that folder's counter kept true. */
const createDocuments = async (
  count: number,
  folderId: string | null,
  teamId: string = ws.teamId,
): Promise<string[]> => {
  const rows = await db
    .insert(documents)
    .values(
      Array.from({ length: count }, () => ({
        teamId,
        folderId,
        status: "ready" as const,
        originalFilename: `doc-${crypto.randomUUID().slice(0, 6)}.pdf`,
        fileSize: 10,
        mimeType: "application/pdf",
        fileHash: crypto.randomUUID(),
      })),
    )
    .returning({ id: documents.id });
  if (folderId !== null) {
    const current = await documentCountOf(folderId);
    await db
      .update(folders)
      .set({ documentCount: current + count })
      .where(eq(folders.id, folderId));
  }
  return rows.map((r) => r.id);
};

const documentCountOf = async (folderId: string): Promise<number> => {
  const row = await db.query.folders.findFirst({
    where: { id: folderId },
    columns: { documentCount: true },
  });
  return row?.documentCount ?? -1;
};

const folderOf = async (documentId: string): Promise<string | null> => {
  const row = await db.query.documents.findFirst({
    where: { id: documentId },
    columns: { folderId: true },
  });
  return row?.folderId ?? null;
};

beforeAll(async () => {
  ws = await createWorkspaceFixture();
});

afterAll(async () => {
  await ws.cleanup();
});

describe("moveDocuments", () => {
  test("moves from several sources and keeps every counter true", async () => {
    const a = await createFolder("A");
    const b = await createFolder("B");
    const target = await createFolder("Target");
    const fromA = await createDocuments(3, a.id);
    const fromB = await createDocuments(2, b.id);
    const fromRoot = await createDocuments(2, null);

    const result = await moveDocuments({
      ids: [...fromA, ...fromB, ...fromRoot],
      teamId: ws.teamId,
      folderId: target.id,
    });

    expect(result.moved).toHaveLength(7);
    expect(result.failed).toEqual([]);
    expect(await documentCountOf(a.id)).toBe(0);
    expect(await documentCountOf(b.id)).toBe(0);
    expect(await documentCountOf(target.id)).toBe(7);
    const rows = await db
      .select({ folderId: documents.folderId })
      .from(documents)
      .where(inArray(documents.id, [...fromA, ...fromB, ...fromRoot]));
    expect(rows.every((r) => r.folderId === target.id)).toBe(true);
  });

  test("to the root: sources decrement, nothing increments", async () => {
    const a = await createFolder("ToRoot");
    const ids = await createDocuments(4, a.id);

    const result = await moveDocuments({
      ids,
      teamId: ws.teamId,
      folderId: null,
    });

    expect(result.moved).toHaveLength(4);
    expect(await documentCountOf(a.id)).toBe(0);
    expect(await folderOf(ids[0] ?? "")).toBeNull();
  });

  test("a document already there is unchanged, not moved twice", async () => {
    const target = await createFolder("Already");
    const [inPlace = ""] = await createDocuments(1, target.id);
    const [elsewhere = ""] = await createDocuments(1, null);

    const result = await moveDocuments({
      ids: [inPlace, elsewhere, elsewhere],
      teamId: ws.teamId,
      folderId: target.id,
    });

    expect(result.moved.map((d) => d.id)).toEqual([elsewhere]);
    expect(result.unchanged).toEqual([inPlace]);
    expect(await documentCountOf(target.id)).toBe(2);
  });

  test("another team's document is refused, and the rest still moves", async () => {
    const other = await ws.createTeam();
    const [foreign = ""] = await createDocuments(1, null, other.id);
    const [mine = ""] = await createDocuments(1, null);
    const target = await createFolder("Mine");

    const result = await moveDocuments({
      ids: [foreign, mine, crypto.randomUUID()],
      teamId: ws.teamId,
      folderId: target.id,
    });

    expect(result.moved.map((d) => d.id)).toEqual([mine]);
    expect(result.failed.map((f) => f.documentId)).toContain(foreign);
    expect(result.failed).toHaveLength(2);
    expect(await folderOf(foreign)).toBeNull();
    expect(await documentCountOf(target.id)).toBe(1);
  });

  test("an unknown destination moves nothing", async () => {
    const [id = ""] = await createDocuments(1, null);
    let error: Error | null = null;
    try {
      await moveDocuments({
        ids: [id],
        teamId: ws.teamId,
        folderId: crypto.randomUUID(),
      });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    expect(error).not.toBeNull();
    expect(await folderOf(id)).toBeNull();
  });

  test("labels the filing decisions of every moved document", async () => {
    const target = await createFolder("Labelled");
    const ids = await createDocuments(2, null);
    await recordDecisions(
      ids.map((id) => ({
        organizationId: ws.organizationId,
        teamId: ws.teamId,
        point: "drive.file",
        family: "folder",
        questionId: "folder",
        questionVersion: 2,
        subjectType: "document",
        subjectId: id,
        targetId: null,
        choice: "__root__",
        outcome: "left" as const,
        applied: true,
        reason: "root",
      })),
    );

    await moveDocuments({ ids, teamId: ws.teamId, folderId: target.id });

    const rows = await db
      .select({ label: decisionLog.label, source: decisionLog.labelSource })
      .from(decisionLog)
      .where(inArray(decisionLog.subjectId, ids));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.label === target.id)).toBe(true);
    expect(rows.every((r) => r.source === "document_moved")).toBe(true);
  });
});

describe("folder moves", () => {
  test("a folder cannot be moved into its own sub-folder", async () => {
    const parent = await createFolder("Parent");
    const child = await createFolder("Child", parent);
    const grandchild = await createFolder("Grandchild", child);

    const result = await moveFolders({
      ids: [parent.id],
      teamId: ws.teamId,
      parentFolderId: grandchild.id,
    });

    expect(result.moved).toEqual([]);
    expect(result.failed[0]?.reason).toContain("sub-folder");
    const row = await db.query.folders.findFirst({
      where: { id: parent.id },
      columns: { parentFolderId: true, fullPath: true },
    });
    expect(row?.parentFolderId).toBeNull();
    expect(row?.fullPath).toBe(parent.fullPath);
  });

  test("nor into itself", async () => {
    const lone = await createFolder("Lone");
    let error: Error | null = null;
    try {
      await updateFolder({
        id: lone.id,
        teamId: ws.teamId,
        updates: { parentFolderId: lone.id },
      });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    expect(error?.message).toContain("sub-folder");
  });

  test("a sibling with the same name is still a legal destination", async () => {
    // A `fullPath` prefix check would read `/Twin` as an ancestor of
    // `/Twin/x`; walking parent ids does not.
    const first = await createFolder("Twin");
    const second = await createFolder("Twin");

    const result = await moveFolders({
      ids: [first.id],
      teamId: ws.teamId,
      parentFolderId: second.id,
    });

    expect(result.failed).toEqual([]);
    expect(result.moved.map((f) => f.id)).toEqual([first.id]);
  });

  test("moves several at once, and one bad id costs only its own row", async () => {
    const dest = await createFolder("Archive");
    const x = await createFolder("X");
    const y = await createFolder("Y");

    const result = await moveFolders({
      ids: [x.id, crypto.randomUUID(), y.id],
      teamId: ws.teamId,
      parentFolderId: dest.id,
    });

    expect(result.moved.map((f) => f.id).sort()).toEqual([x.id, y.id].sort());
    expect(result.failed).toHaveLength(1);
    const moved = await db
      .select({ fullPath: folders.fullPath })
      .from(folders)
      .where(inArray(folders.id, [x.id, y.id]));
    expect(moved.map((f) => f.fullPath).sort()).toEqual(
      ["/Archive/X", "/Archive/Y"].sort(),
    );
    const destRow = await db.query.folders.findFirst({
      where: { id: dest.id },
      columns: { subFolderCount: true },
    });
    expect(destRow?.subFolderCount).toBe(2);
  });
});
