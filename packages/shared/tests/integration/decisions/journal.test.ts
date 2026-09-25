import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import db from "../../../src/db";
import { decisionLog, documents, folders } from "../../../src/db/schema";
import {
  labelDecisions,
  purgeDecisionLog,
  recordDecisions,
  type JournalEntry,
} from "../../../src/services/decisions/journal";
import { updateDocument } from "../../../src/services/documents/update";
import { ROOT_OPTION } from "../../../src/services/folders/auto-file";
import { confirmAutoFiling } from "../../../src/services/folders/confirm-filing";
import { listAutoFiled } from "../../../src/services/folders/list-auto-filed";
import { undoAutoFiling } from "../../../src/services/folders/undo-filing";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The decision journal against a real Postgres.
 *
 * Every claim here is a WHERE clause: that a retried batch is a no-op
 * (the unique index), that an inferred label never overwrites a person's
 * (`label IS NULL` on inferred sources only), that a label stays inside its
 * team, that the GC keeps exactly what it promises, and that the filer's
 * feedback routes refuse a document a person has moved since. A faked `db`
 * would pass all of them with the clauses deleted.
 */

let ws: WorkspaceFixture;

const randomUUID = (): string => crypto.randomUUID();

/**
 * The error a call threw, or null. A try/catch rather than
 * `.rejects.toThrow()`: Bun types that matcher as void, so the `await` the
 * linter removes is the one that makes it assert anything (same helper as
 * `bulk-operations/executor-tx.test.ts`).
 */
const caught = async (run: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const gateEntry = (over: Partial<JournalEntry>): JournalEntry => ({
  organizationId: ws.organizationId,
  teamId: ws.teamId,
  point: "workflow.gate",
  family: "wf",
  questionId: `wf:${randomUUID()}`,
  questionVersion: 2,
  subjectType: "domain_event",
  subjectId: randomUUID(),
  targetId: randomUUID(),
  outcome: "allowed",
  applied: true,
  probability: 0.6,
  threshold: 0.15,
  ...over,
});

const rowsFor = (subjectId: string) =>
  db.select().from(decisionLog).where(eq(decisionLog.subjectId, subjectId));

const createFolder = async (name: string): Promise<string> => {
  const [row] = await db
    .insert(folders)
    .values({ teamId: ws.teamId, name, fullPath: `/${name}` })
    .returning({ id: folders.id });
  if (!row) throw new Error("fixture: folder");
  return row.id;
};

const createDocument = async (folderId: string | null): Promise<string> => {
  const [row] = await db
    .insert(documents)
    .values({
      teamId: ws.teamId,
      folderId,
      status: "ready",
      originalFilename: `doc-${randomUUID().slice(0, 6)}.pdf`,
      fileSize: 10,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: document");
  if (folderId !== null) {
    await db
      .update(folders)
      .set({ documentCount: 1 })
      .where(eq(folders.id, folderId));
  }
  return row.id;
};

const fileEntry = (documentId: string, folderId: string): JournalEntry => ({
  organizationId: ws.organizationId,
  teamId: ws.teamId,
  point: "drive.file",
  family: "folder",
  questionId: "folder",
  questionVersion: 2,
  subjectType: "document",
  subjectId: documentId,
  targetId: folderId,
  choice: folderId,
  outcome: "filed",
  applied: true,
  probability: 0.8,
  confidence: 0.9,
  threshold: 0.75,
});

const documentCountOf = async (folderId: string): Promise<number> => {
  const row = await db.query.folders.findFirst({
    where: { id: folderId },
    columns: { documentCount: true },
  });
  return row?.documentCount ?? -1;
};

beforeAll(async () => {
  ws = await createWorkspaceFixture();
});

afterAll(async () => {
  await ws.cleanup();
});

describe("recordDecisions", () => {
  test("a retried batch writes nothing the second time", async () => {
    const entry = gateEntry({});
    expect(await recordDecisions([entry])).toBe(1);
    expect(await recordDecisions([entry])).toBe(0);
    expect(await rowsFor(entry.subjectId)).toHaveLength(1);
  });

  test("an unknown point is never journaled", async () => {
    const entry = gateEntry({ point: "nowhere" });
    expect(await recordDecisions([entry])).toBe(0);
  });
});

describe("labelDecisions", () => {
  test("an inference fills an empty label and never replaces a person's", async () => {
    const entry = gateEntry({});
    await recordDecisions([entry]);
    await labelDecisions({
      teamId: ws.teamId,
      point: "workflow.gate",
      subjectId: entry.subjectId,
      label: "true",
      source: "run_anyway",
      userId: ws.userIds[0],
    });
    await labelDecisions({
      teamId: ws.teamId,
      point: "workflow.gate",
      subjectId: entry.subjectId,
      label: "false",
      source: "run_outcome",
    });
    const [row] = await rowsFor(entry.subjectId);
    expect(row?.label).toBe("true");
    expect(row?.labelSource).toBe("run_anyway");
    expect(row?.labeledByUserId).toBe(ws.userIds[0]);
  });

  test("an explicit act replaces an inference", async () => {
    const entry = gateEntry({});
    await recordDecisions([entry]);
    for (const [label, source] of [
      ["false", "run_outcome"],
      ["true", "manual"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await labelDecisions({
        teamId: ws.teamId,
        point: "workflow.gate",
        subjectId: entry.subjectId,
        label,
        source,
      });
    }
    const [row] = await rowsFor(entry.subjectId);
    expect(row?.label).toBe("true");
  });

  test("a target narrows the label to one workflow of the event", async () => {
    const subjectId = randomUUID();
    const a = gateEntry({ subjectId });
    const b = gateEntry({ subjectId });
    await recordDecisions([a, b]);
    await labelDecisions({
      teamId: ws.teamId,
      point: "workflow.gate",
      subjectId,
      ...(a.targetId ? { targetId: a.targetId } : {}),
      label: "false",
      source: "run_outcome",
    });
    const rows = await rowsFor(subjectId);
    const byTarget = new Map(rows.map((r) => [r.targetId, r.label]));
    expect(byTarget.get(a.targetId ?? "")).toBe("false");
    expect(byTarget.get(b.targetId ?? "")).toBeNull();
  });

  test("a label never crosses into another team", async () => {
    const other = await ws.createTeam();
    const subjectId = randomUUID();
    await recordDecisions([
      gateEntry({ subjectId }),
      gateEntry({ subjectId, teamId: other.id }),
    ]);
    await labelDecisions({
      teamId: ws.teamId,
      point: "workflow.gate",
      subjectId,
      label: "true",
      source: "manual",
    });
    const rows = await rowsFor(subjectId);
    const byTeam = new Map(rows.map((r) => [r.teamId, r.label]));
    expect(byTeam.get(ws.teamId)).toBe("true");
    expect(byTeam.get(other.id)).toBeNull();
  });
});

describe("purgeDecisionLog", () => {
  test("unlabelled rows go after 30 days, labelled ones after a year", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * day);
    const cases = [
      { days: 31, label: null, survives: false },
      { days: 29, label: null, survives: true },
      { days: 31, label: "true", survives: true },
      { days: 366, label: "true", survives: false },
    ];
    const ids: string[] = [];
    for (const c of cases) {
      // eslint-disable-next-line no-await-in-loop
      const [row] = await db
        .insert(decisionLog)
        .values({ ...gateEntry({}), label: c.label, createdAt: ago(c.days) })
        .returning({ id: decisionLog.id });
      ids.push(row?.id ?? "");
    }

    await purgeDecisionLog(now);

    const left = await db
      .select({ id: decisionLog.id })
      .from(decisionLog)
      .where(inArray(decisionLog.id, ids));
    const survivors = new Set(left.map((r) => r.id));
    cases.forEach((c, i) => {
      expect(survivors.has(ids[i] ?? "")).toBe(c.survives);
    });
  });
});

describe("the filer's feedback", () => {
  test("a document counts as auto-filed only while it sits where it was put", async () => {
    const invoices = await createFolder(`inv-${randomUUID().slice(0, 4)}`);
    const other = await createFolder(`oth-${randomUUID().slice(0, 4)}`);
    const staying = await createDocument(invoices);
    const moved = await createDocument(other);
    const refused = await createDocument(invoices);
    await recordDecisions([
      fileEntry(staying, invoices),
      fileEntry(moved, invoices),
      fileEntry(refused, invoices),
    ]);
    await labelDecisions({
      teamId: ws.teamId,
      point: "drive.file",
      subjectId: refused,
      label: ROOT_OPTION,
      source: "manual",
    });

    const result = await listAutoFiled({
      teamId: ws.teamId,
      documents: [
        { id: staying, folderId: invoices },
        { id: moved, folderId: other },
        { id: refused, folderId: invoices },
      ],
    });
    expect(result.get(staying)?.confirmed).toBe(false);
    expect(result.has(moved)).toBe(false);
    expect(result.has(refused)).toBe(false);
  });

  test("undo moves the document back, gives the count back, and labels the root", async () => {
    const folderId = await createFolder(`u-${randomUUID().slice(0, 4)}`);
    const documentId = await createDocument(folderId);
    await recordDecisions([fileEntry(documentId, folderId)]);

    await undoAutoFiling({
      documentId,
      teamId: ws.teamId,
      userId: ws.userIds[0],
    });

    const doc = await db.query.documents.findFirst({
      where: { id: documentId },
      columns: { folderId: true },
    });
    expect(doc?.folderId).toBeNull();
    expect(await documentCountOf(folderId)).toBe(0);
    const [row] = await rowsFor(documentId);
    expect(row?.label).toBe(ROOT_OPTION);
    expect(row?.labelSource).toBe("filing_undone");
  });

  test("undo and confirm refuse a document a person has moved since", async () => {
    const filed = await createFolder(`f-${randomUUID().slice(0, 4)}`);
    const elsewhere = await createFolder(`e-${randomUUID().slice(0, 4)}`);
    const documentId = await createDocument(elsewhere);
    await recordDecisions([fileEntry(documentId, filed)]);

    const call = { documentId, teamId: ws.teamId, userId: ws.userIds[0] };
    expect((await caught(() => undoAutoFiling(call)))?.message).toContain(
      "moved since",
    );
    expect((await caught(() => confirmAutoFiling(call)))?.message).toContain(
      "moved since",
    );
    const doc = await db.query.documents.findFirst({
      where: { id: documentId },
      columns: { folderId: true },
    });
    expect(doc?.folderId).toBe(elsewhere);
  });

  test("another team cannot undo this team's filing", async () => {
    const other = await ws.createTeam();
    const folderId = await createFolder(`t-${randomUUID().slice(0, 4)}`);
    const documentId = await createDocument(folderId);
    await recordDecisions([fileEntry(documentId, folderId)]);
    const error = await caught(() =>
      undoAutoFiling({ documentId, teamId: other.id, userId: ws.userIds[1] }),
    );
    expect(error?.message).toContain("Automatic filing");
    expect(await documentCountOf(folderId)).toBe(1);
  });

  test("confirming labels the chosen folder and moves nothing", async () => {
    const folderId = await createFolder(`c-${randomUUID().slice(0, 4)}`);
    const documentId = await createDocument(folderId);
    await recordDecisions([fileEntry(documentId, folderId)]);
    await confirmAutoFiling({
      documentId,
      teamId: ws.teamId,
      userId: ws.userIds[0],
    });
    const result = await listAutoFiled({
      teamId: ws.teamId,
      documents: [{ id: documentId, folderId }],
    });
    expect(result.get(documentId)?.confirmed).toBe(true);
  });
});

describe("updateDocument and the journal", () => {
  test("a rename is not a move: the folder keeps its count", async () => {
    // It read as a move to `undefined` and decremented the folder for a
    // document that never left it.
    const folderId = await createFolder(`r-${randomUUID().slice(0, 4)}`);
    const documentId = await createDocument(folderId);
    await updateDocument({
      id: documentId,
      teamId: ws.teamId,
      organizationId: ws.organizationId,
      updates: { originalFilename: "renamed" },
    });
    expect(await documentCountOf(folderId)).toBe(1);
  });

  test("a person filing a document the filer LEFT at the root labels the decision", async () => {
    const target = await createFolder(`m-${randomUUID().slice(0, 4)}`);
    const documentId = await createDocument(null);
    await recordDecisions([
      {
        ...fileEntry(documentId, target),
        outcome: "left",
        reason: "below_threshold",
      },
    ]);
    await updateDocument({
      id: documentId,
      teamId: ws.teamId,
      organizationId: ws.organizationId,
      updates: { folderId: target },
    });
    const [row] = await db
      .select()
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.subjectId, documentId),
          eq(decisionLog.point, "drive.file"),
        ),
      );
    expect(row?.label).toBe(target);
    expect(row?.labelSource).toBe("document_moved");
  });
});
