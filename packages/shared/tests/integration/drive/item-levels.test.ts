import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  accessGrants,
  documents,
  folders,
  teamMember,
  teamMemberRoles,
} from "../../../src/db/schema";
import { getRootDrive } from "../../../src/services/folders/retrieve";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * A Drive list carries the caller's level on each item
 * (`services/folders/retrieve.ts`), so an item's menu offers what that level
 * allows and nothing the server would refuse.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let viewerId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId] = fx.userIds;
  viewerId = await fx.addPerson();
  const [seat] = await db
    .select({ id: teamMember.id })
    .from(teamMember)
    .where(
      and(eq(teamMember.teamId, fx.teamId), eq(teamMember.userId, viewerId)),
    );
  if (!seat) throw new Error("fixture: no seat");
  await db.insert(teamMemberRoles).values({
    teamMemberId: seat.id,
    teamId: fx.teamId,
    userId: viewerId,
    role: "viewer",
  });
});

afterEach(async () => {
  await fx.cleanup();
});

const levelsAt = async (userId: string) => {
  const root = await getRootDrive({
    principal: await fx.principalOf(userId),
    teamId: fx.teamId,
    projectId: null,
    params: { page: 0, limit: 50, filters: [] },
  });
  return new Map(root.children.data.map((item) => [item.data.id, item.level]));
};

describe("a Drive list", () => {
  test("says what each item gives the one who lists it", async () => {
    const tag = randomUUID().slice(0, 8);
    const [folder] = await db
      .insert(folders)
      .values({
        teamId: fx.teamId,
        name: `folder-${tag}`,
        fullPath: `/folder-${tag}`,
        createdById: ownerId,
        ownerUserId: ownerId,
      })
      .returning({ id: folders.id });
    const [file] = await db
      .insert(documents)
      .values({
        teamId: fx.teamId,
        status: "ready",
        originalFilename: `file-${tag}.pdf`,
        fileSize: 1024,
        mimeType: "application/pdf",
        fileHash: randomUUID(),
        ownerUserId: ownerId,
        uploadedById: ownerId,
      })
      .returning({ id: documents.id });
    if (!folder || !file) throw new Error("fixture: no items");
    // The viewer is given more on the file than their role gives them.
    await db.insert(accessGrants).values({
      organizationId: fx.organizationId,
      resourceType: "document",
      resourceId: file.id,
      principalType: "user",
      principalId: viewerId,
      level: "edit",
    });

    const owner = await levelsAt(ownerId);
    expect(owner.get(folder.id)).toBe("full");
    expect(owner.get(file.id)).toBe("full");

    const viewer = await levelsAt(viewerId);
    expect(viewer.get(folder.id)).toBe("view");
    expect(viewer.get(file.id)).toBe("edit");
  });
});
