/**
 * `manageDrive` and `manageLink` in their batch shape, executed as the agent
 * executes them, against a real Postgres.
 *
 * Both tools took ONE item per call until a request to tidy a 762-document
 * Drive showed what that costs: one agent step per move, thirty steps a turn,
 * thirty documents filed. What these tests hold is the contract the batch
 * shape promises in its place:
 *
 *  - one stale id is reported in `failed` and costs only its own row;
 *  - a gated write opens ONE approval for the whole set, and granting it
 *    applies exactly that set through the shared apply map (the path an
 *    approval clicked in the UI takes, in another process);
 *  - an edge from another organization cannot be unlinked by guessing its id,
 *    which a bare `invalidateLink(id)` allowed.
 *
 * Nothing is doubled but what the preload always doubles: no S3 call is
 * reached (the deleted folders are empty), and the relation resolves by its
 * exact key, so the decision model is never asked.
 */
import db from "@fretik/shared/db";
import { documents, folders, links, linkTypes } from "@fretik/shared/db/schema";
import { TOOL_CALL_APPLY } from "@fretik/shared/services/tool-policies/builtin-apply";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import {
  createManageDriveTool,
  manageDriveInputSchema,
} from "../../../src/tools/manage-drive";
import {
  createManageLinkTool,
  manageLinkInputSchema,
} from "../../../src/tools/manage-link";
import { asToolRecord } from "../../lib/tool-result";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../lib/db-fixtures";

let fx: MemoryTestFixture;
let other: MemoryTestFixture;
let conversationId: string;

const options = (toolPolicies?: Record<string, "auto" | "approval">) => ({
  toolCallId: `tc-${randomUUID()}`,
  messages: [] as never[],
  context: wrapRuntimeContext({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: fx.userIds[0],
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
    ...(toolPolicies ? { toolPolicies } : {}),
  }),
});

/** A tool result as a plain field map, for assertions on any of its keys. */
const fields = (result: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(result));

const runDrive = async (
  input: Record<string, unknown>,
  toolPolicies?: Record<string, "auto" | "approval">,
): Promise<Record<string, unknown>> => {
  const tool = createManageDriveTool();
  if (!tool.execute) throw new Error("manageDrive has no execute");
  return fields(
    asToolRecord(
      "manageDrive",
      await tool.execute(
        manageDriveInputSchema.parse(input),
        options(toolPolicies),
      ),
    ),
  );
};

const runLink = async (
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const tool = createManageLinkTool();
  if (!tool.execute) throw new Error("manageLink has no execute");
  return fields(
    asToolRecord(
      "manageLink",
      await tool.execute(manageLinkInputSchema.parse(input), options()),
    ),
  );
};

const createFolder = async (name: string): Promise<string> => {
  const [row] = await db
    .insert(folders)
    .values({ teamId: fx.teamId, name, fullPath: `/${name}` })
    .returning({ id: folders.id });
  if (!row) throw new Error("fixture: folder");
  return row.id;
};

const createDocuments = async (count: number): Promise<string[]> => {
  const rows = await db
    .insert(documents)
    .values(
      Array.from({ length: count }, () => ({
        teamId: fx.teamId,
        status: "ready" as const,
        originalFilename: `doc-${randomUUID().slice(0, 6)}.pdf`,
        fileSize: 10,
        mimeType: "application/pdf",
        fileHash: randomUUID(),
      })),
    )
    .returning({ id: documents.id });
  return rows.map((r) => r.id);
};

beforeAll(async () => {
  fx = await createMemoryTestFixture();
  other = await createMemoryTestFixture();
  conversationId = await fx.createConversation();
});

afterAll(async () => {
  await fx.cleanup();
  await other.cleanup();
});

describe("manageDrive — batch moves and deletes", () => {
  test("moves every document of the list in one call, and reports the stale id", async () => {
    const target = await createFolder(`Target ${randomUUID().slice(0, 4)}`);
    const ids = await createDocuments(3);
    const stale = randomUUID();

    const out = await runDrive({
      action: "moveDocument",
      documentIds: [...ids, stale],
      parentFolderId: target,
    });

    expect(out.moved).toBe(3);
    expect(out.ok).toBe(false);
    expect(out.failed).toEqual([{ documentId: stale, reason: "not_found" }]);
    const rows = await db
      .select({ folderId: documents.folderId })
      .from(documents)
      .where(inArray(documents.id, ids));
    expect(rows.every((r) => r.folderId === target)).toBe(true);
    const folder = await db.query.folders.findFirst({
      where: { id: target },
      columns: { documentCount: true },
    });
    expect(folder?.documentCount).toBe(3);
  });

  test("refuses an unknown destination before moving anything", async () => {
    const [id = ""] = await createDocuments(1);
    const out = await runDrive({
      action: "moveDocument",
      documentIds: [id],
      parentFolderId: randomUUID(),
    });
    expect(out.code).toBe("NOT_FOUND");
    const row = await db.query.documents.findFirst({
      where: { id },
      columns: { folderId: true },
    });
    expect(row?.folderId).toBeNull();
  });

  test("deletes the folders that exist and reports the one that does not", async () => {
    // `deleteFolder` defaults to `approval`, whose gate runs a Redis script the
    // test double does not carry; the team allowing it is the direct path.
    const a = await createFolder(`Old A ${randomUUID().slice(0, 4)}`);
    const b = await createFolder(`Old B ${randomUUID().slice(0, 4)}`);
    const keep = await createFolder(`Keep ${randomUUID().slice(0, 4)}`);
    const stale = randomUUID();

    const out = await runDrive(
      { action: "deleteFolder", folderIds: [a, b, stale] },
      { "manageDrive.deleteFolder": "auto" },
    );

    expect(out.deletedFolderIds).toEqual([a, b]);
    expect(out.failed).toEqual([{ folderId: stale, reason: "not_found" }]);
    const left = await db
      .select({ id: folders.id })
      .from(folders)
      .where(inArray(folders.id, [a, b, keep]));
    expect(left.map((f) => f.id)).toEqual([keep]);
  });

  test("a batch grant applies exactly its set, through the shared apply map", async () => {
    // The args the tool stores on the approval: `folderIds`, already cut to
    // the folders that exist. The grant runs in another process, from these.
    const a = await createFolder(`Grant A ${randomUUID().slice(0, 4)}`);
    const b = await createFolder(`Grant B ${randomUUID().slice(0, 4)}`);
    const keep = await createFolder(`Grant keep ${randomUUID().slice(0, 4)}`);
    const apply = TOOL_CALL_APPLY.manageDrive;
    if (!apply) throw new Error("no apply for manageDrive");

    await apply(
      {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: fx.userIds[0],
        conversationId,
      },
      { action: "deleteFolder", folderIds: [a, b], parentFolderId: null },
    );

    const left = await db
      .select({ id: folders.id })
      .from(folders)
      .where(inArray(folders.id, [a, b, keep]));
    expect(left.map((f) => f.id)).toEqual([keep]);
  });

  test("a grant stored before the batch change still applies its one folder", async () => {
    const legacy = await createFolder(`Legacy ${randomUUID().slice(0, 4)}`);
    const apply = TOOL_CALL_APPLY.manageDrive;
    if (!apply) throw new Error("no apply for manageDrive");
    await apply(
      {
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: fx.userIds[0],
        conversationId,
      },
      { action: "deleteFolder", folderId: legacy, parentFolderId: null },
    );
    const row = await db.query.folders.findFirst({ where: { id: legacy } });
    expect(row).toBeUndefined();
  });
});

describe("manageLink — batch link and unlink", () => {
  const relationKey = `works_with_${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    // Every record of the fixture shares one collection, so one type serves
    // every test's source record.
    const probe = await fx.createRecord("Probe");
    const source = await db.query.collectionRecords.findFirst({
      where: { id: probe },
      columns: { collectionId: true },
    });
    await db.insert(linkTypes).values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      key: relationKey,
      normalizedKey: relationKey,
      label: "Works with",
      fromCollectionId: source?.collectionId ?? "",
    });
  });

  const edgesFrom = async (from: string) =>
    db
      .select({ id: links.id, to: links.toRecordId })
      .from(links)
      .where(eq(links.fromRecordId, from));

  test("links several targets in one call; a repeat is a no-op and a pending file is reported", async () => {
    const from = await fx.createRecord("Source");
    const t1 = await fx.createRecord("T1");
    const t2 = await fx.createRecord("T2");

    const out = await runLink({
      action: "link",
      relationKey,
      links: [
        { fromRecordId: from, toRecordId: t1 },
        { fromRecordId: from, toRecordId: t2 },
        { fromRecordId: from, toRecordId: t1 },
        { fromRecordId: from, toDocumentId: randomUUID() },
      ],
    });

    expect(out.linked).toBe(2);
    expect(out.alreadyLinked).toBe(1);
    expect(out.failed).toEqual([
      {
        index: 3,
        reason:
          "No document record for this file yet — it may still be processing.",
      },
    ]);
    const edges = await edgesFrom(from);
    expect(edges.map((e) => e.to).sort()).toEqual([t1, t2].sort());
  });

  test("one edge is a list of one", async () => {
    const from = await fx.createRecord("Single source");
    const to = await fx.createRecord("Single target");
    const out = await runLink({
      action: "link",
      relationKey,
      links: [{ fromRecordId: from, toRecordId: to }],
    });
    expect(out.linked).toBe(1);
    expect(typeof out.linkId).toBe("string");
  });

  test("the pre-batch single-edge shape gets a recoverable error naming `links`", async () => {
    const out = await runLink({
      action: "link",
      relationKey,
      fromRecordId: await fx.createRecord("Old shape"),
      toRecordId: await fx.createRecord("Old target"),
    });
    expect(out.code).toBe("COLLECTION_QUERY_ERROR");
    expect(String(out.error)).toContain("links");
  });

  test("unlinks a list, refuses another organization's edge, and a second pass is a no-op", async () => {
    const from = await fx.createRecord("Unlink source");
    await runLink({
      action: "link",
      relationKey,
      links: [
        { fromRecordId: from, toRecordId: await fx.createRecord("U1") },
        { fromRecordId: from, toRecordId: await fx.createRecord("U2") },
      ],
    });
    const mine = (await edgesFrom(from)).map((e) => e.id);
    expect(mine).toHaveLength(2);

    // An edge in ANOTHER workspace, whose id the agent could only guess.
    const foreignFrom = await other.createRecord("Foreign");
    const foreignTo = await other.createRecord("Foreign target");
    const foreignSource = await db.query.collectionRecords.findFirst({
      where: { id: foreignFrom },
      columns: { collectionId: true },
    });
    const [foreignType] = await db
      .insert(linkTypes)
      .values({
        organizationId: other.organizationId,
        teamId: other.teamId,
        key: relationKey,
        normalizedKey: relationKey,
        label: "Works with",
        fromCollectionId: foreignSource?.collectionId ?? "",
      })
      .returning({ id: linkTypes.id });
    const [foreign] = await db
      .insert(links)
      .values({
        organizationId: other.organizationId,
        teamId: other.teamId,
        linkTypeId: foreignType?.id ?? "",
        fromRecordId: foreignFrom,
        toRecordId: foreignTo,
      })
      .returning({ id: links.id });

    const out = await runLink({
      action: "unlink",
      linkIds: [...mine, foreign?.id],
    });

    expect(out.unlinked).toBe(2);
    expect(out.failed).toEqual([
      { linkId: foreign?.id, reason: "Link not found." },
    ]);
    const foreignRow = await db.query.links.findFirst({
      where: { id: foreign?.id ?? "" },
      columns: { invalidatedAt: true },
    });
    expect(foreignRow?.invalidatedAt).toBeNull();
    const mineRows = await db
      .select({ invalidatedAt: links.invalidatedAt })
      .from(links)
      .where(inArray(links.id, mine));
    expect(mineRows.every((r) => r.invalidatedAt !== null)).toBe(true);

    const again = await runLink({ action: "unlink", linkIds: mine });
    expect(again.unlinked).toBe(0);
    expect(again.failed).toEqual([]);
  });
});
