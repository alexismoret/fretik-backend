import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { documents, pages, teamMember } from "../../../src/db/schema";
import { listSharedWithMe } from "../../../src/services/access/sharing/list-shared-with-me";
import { revokeGrant } from "../../../src/services/access/sharing/revoke-grant";
import { setGeneralAccess } from "../../../src/services/access/sharing/set-general-access";
import { shareResource } from "../../../src/services/access/sharing/share";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * "Shared with me": what others shared with a person, where they find it
 * again — by name, or through a group they are in when the item is from a
 * team they are not part of.
 *
 * The workspace's owner and member are in its team; a third person is in a
 * second team only, the outsider every cross-team share is about.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;
let outsiderId: string;
let otherTeamId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  otherTeamId = (await fx.createTeam()).id;
  outsiderId = await fx.addPerson({ inTeam: false });
  await db
    .insert(teamMember)
    .values({ userId: outsiderId, teamId: otherTeamId, createdAt: new Date() });
});

afterEach(async () => {
  await fx.cleanup();
});

const insertDocument = async (): Promise<string> => {
  const [row] = await db
    .insert(documents)
    .values({
      teamId: fx.teamId,
      status: "ready",
      originalFilename: `file-${randomUUID().slice(0, 8)}.pdf`,
      fileSize: 1024,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
      ownerUserId: ownerId,
      uploadedById: ownerId,
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: no document");
  return row.id;
};

const share = async (
  id: string,
  principals: { type: "user" | "team" | "organization"; id: string }[],
  level: "view" | "edit" = "view",
  type: "document" | "page" = "document",
) =>
  shareResource({
    principal: await fx.principalOf(ownerId),
    type,
    id,
    principals,
    level,
  });

const sharedWith = async (userId: string) =>
  (await listSharedWithMe(await fx.principalOf(userId))).items.map((item) => ({
    id: item.resource.id,
    via: item.via,
    level: item.level,
  }));

describe("shared by name", () => {
  test("a document shared with someone is theirs to find, with who shared it", async () => {
    const doc = await insertDocument();
    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
      restricted: true,
    });
    await share(doc, [{ type: "user", id: memberId }]);

    const { items } = await listSharedWithMe(await fx.principalOf(memberId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      resource: { type: "document", id: doc, teamId: fx.teamId },
      level: "view",
      via: "user",
      sharedBy: { userId: ownerId },
      mimeType: "application/pdf",
    });
    // The owner's own things are not shared with them.
    expect(await sharedWith(ownerId)).toEqual([]);
  });

  test("the grant a person keeps when restricting someone else's item is not a share", async () => {
    const doc = await insertDocument();
    await setGeneralAccess({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
      restricted: true,
    });
    expect(await sharedWith(memberId)).toEqual([]);
  });
});

describe("shared with a group", () => {
  test("a share with a team reaches its people when the item is from another team", async () => {
    const doc = await insertDocument();
    await share(doc, [{ type: "team", id: otherTeamId }]);

    const { items } = await listSharedWithMe(await fx.principalOf(outsiderId));
    expect(items.map((item) => [item.resource.id, item.via])).toEqual([
      [doc, "team"],
    ]);
    expect(items[0]?.resource.teamName).not.toBeNull();
  });

  test("a group's share of something in one's own team is found in the team", async () => {
    const doc = await insertDocument();
    await share(doc, [{ type: "team", id: fx.teamId }], "edit");
    await share(doc, [{ type: "organization", id: fx.organizationId }]);

    expect(await sharedWith(memberId)).toEqual([]);
  });

  test("a share with the organization is found by those outside the item's team", async () => {
    const doc = await insertDocument();
    await share(doc, [{ type: "organization", id: fx.organizationId }]);

    expect(await sharedWith(outsiderId)).toEqual([
      { id: doc, via: "organization", level: "view" },
    ]);
  });

  test("the most personal share says how it reached them", async () => {
    const doc = await insertDocument();
    await share(doc, [{ type: "team", id: otherTeamId }]);
    await share(doc, [{ type: "user", id: outsiderId }], "edit");

    expect(await sharedWith(outsiderId)).toEqual([
      { id: doc, via: "user", level: "edit" },
    ]);
  });
});

describe("leaving the list", () => {
  test("what is taken back, archived or gone is no longer listed", async () => {
    const revoked = await insertDocument();
    const gone = await insertDocument();
    const page = await fx.createPage({ ownerUserId: ownerId });
    for (const id of [revoked, gone]) {
      // oxlint-disable-next-line no-await-in-loop -- two shares, in order
      await share(id, [{ type: "user", id: outsiderId }]);
    }
    await share(page.id, [{ type: "user", id: outsiderId }], "view", "page");
    expect(await sharedWith(outsiderId)).toHaveLength(3);

    await revokeGrant({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: revoked,
      holder: { type: "user", id: outsiderId },
    });
    await db.delete(documents).where(eq(documents.id, gone));
    await db
      .update(pages)
      .set({ archivedAt: new Date() })
      .where(eq(pages.id, page.id));

    expect(await sharedWith(outsiderId)).toEqual([]);
  });
});
