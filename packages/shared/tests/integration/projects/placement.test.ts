import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { adapterFor, resolveAccess } from "../../../src/authz/access";
import { requireDriveMove } from "../../../src/authz/drive";
import { requirePlacement } from "../../../src/authz/placement";
import db from "../../../src/db";
import {
  aiVectors,
  documents,
  folders,
  teamMember,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import { shareResource } from "../../../src/services/access/sharing/share";
import { aclOfNode } from "../../../src/services/ai-vectors/acl";
import { createConversation } from "../../../src/services/ai/create";
import { updateDocument } from "../../../src/services/documents/update";
import { createDocumentRecord } from "../../../src/services/documents/upload";
import { createFolder } from "../../../src/services/folders/create";
import { getRootDrive } from "../../../src/services/folders/retrieve";
import { updateFolder } from "../../../src/services/folders/update";
import { listPages } from "../../../src/services/pages/retrieve";
import { setProjectArchived } from "../../../src/services/projects/archive";
import { createProject } from "../../../src/services/projects/create";
import { moveToProject } from "../../../src/services/projects/move-content";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * Where content lands in a project, and how it moves in and out.
 *
 * `member` is a member of the team; `outsider` is in another team and takes
 * part in the project (`use`) through a grant.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;
let outsiderId: string;
let otherTeamId: string;
let projectId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  otherTeamId = (await fx.createTeam()).id;
  outsiderId = await fx.addPerson({ inTeam: false });
  await db
    .insert(teamMember)
    .values({ userId: outsiderId, teamId: otherTeamId, createdAt: new Date() });
  projectId = (
    await createProject({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      project: { name: "Acme case", description: "", restricted: true },
    })
  ).id;
  await shareResource({
    principal: await fx.principalOf(ownerId),
    type: "project",
    id: projectId,
    principals: [
      { type: "user", id: memberId },
      { type: "user", id: outsiderId },
    ],
    level: "use",
  });
});

afterEach(async () => {
  await fx.cleanup();
});

const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

const folderIn = async (input: {
  name: string;
  parentFolderId?: string | null;
  projectId?: string | null;
  by?: string;
}) =>
  createFolder({
    name: input.name,
    parentFolderId: input.parentFolderId ?? null,
    teamId: fx.teamId,
    projectId: input.projectId ?? null,
    userId: input.by ?? ownerId,
  });

const documentIn = async (input: {
  folderId: string | null;
  projectId?: string | null;
  by?: string;
}) =>
  createDocumentRecord({
    metadata: {
      id: crypto.randomUUID(),
      folderId: input.folderId,
      originalFilename: `file-${crypto.randomUUID().slice(0, 6)}.pdf`,
      fileSize: 1,
      mimeType: "application/pdf",
      fileHash: crypto.randomUUID(),
    },
    teamId: fx.teamId,
    userId: input.by ?? ownerId,
    projectId: input.projectId ?? null,
    status: "ready",
  });

const projectOf = async (table: "folder" | "document", id: string) => {
  if (table === "folder") {
    const [row] = await db
      .select({ projectId: folders.projectId })
      .from(folders)
      .where(eq(folders.id, id));
    return row?.projectId ?? null;
  }
  const [row] = await db
    .select({ projectId: documents.projectId })
    .from(documents)
    .where(eq(documents.id, id));
  return row?.projectId ?? null;
};

describe("where new content lands", () => {
  test("in a project, for someone of another team who takes part in it", async () => {
    const outsider = await fx.principalOf(outsiderId);
    const placement = await requirePlacement({
      principal: outsider,
      activeTeamId: otherTeamId,
      projectId,
    });
    expect(placement).toEqual({ teamId: fx.teamId, projectId });

    const chat = await createConversation({
      organizationId: fx.organizationId,
      teamId: placement.teamId,
      projectId: placement.projectId,
      userId: outsiderId,
      title: "Kick-off",
    });
    expect(chat.projectId).toBe(projectId);
    // Their own chat, which they take part in, though not of its team.
    expect(
      (await resolveAccess(outsider, "conversation", chat.id))?.level,
    ).toBe("full");
  });

  test("never at their team's root for someone outside it, nor in a project they only view", async () => {
    const outsider = await fx.principalOf(outsiderId);
    expect(
      await refusal(
        requirePlacement({ principal: outsider, activeTeamId: fx.teamId }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });

    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: projectId,
      principals: [{ type: "user", id: outsiderId }],
      level: "view",
    });
    expect(
      await refusal(
        requirePlacement({
          principal: await fx.principalOf(outsiderId),
          activeTeamId: otherTeamId,
          projectId,
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });

  test("an archived project takes nothing new", async () => {
    await setProjectArchived({
      principal: await fx.principalOf(ownerId),
      projectId,
      archived: true,
    });
    expect(
      await refusal(
        requirePlacement({
          principal: await fx.principalOf(memberId),
          activeTeamId: fx.teamId,
          projectId,
        }),
      ),
    ).toEqual({ status: 409, code: "PROJECT_ARCHIVED" });
  });

  test("a folder and a file take their parent's project, whatever is asked", async () => {
    const root = await folderIn({ name: "Contracts", projectId });
    const sub = await folderIn({ name: "Signed", parentFolderId: root.id });
    const file = await documentIn({ folderId: sub.id, projectId: null });

    expect(root.projectId).toBe(projectId);
    expect(sub.projectId).toBe(projectId);
    expect(file.projectId).toBe(projectId);
    // Placing into a project's folder names that folder's project.
    expect(
      await requirePlacement({
        principal: await fx.principalOf(ownerId),
        activeTeamId: fx.teamId,
        folderId: sub.id,
      }),
    ).toEqual({ teamId: fx.teamId, projectId });
  });

  test("a team's root and a project's root are different places", async () => {
    const teamFolder = await folderIn({ name: "Team" });
    const projectFolder = await folderIn({ name: "Project", projectId });
    const teamFile = await documentIn({ folderId: null });
    const projectFile = await documentIn({ folderId: null, projectId });
    const owner = await fx.principalOf(ownerId);
    const params = { page: 0, limit: 50, filters: [] };

    const teamRoot = await getRootDrive({
      principal: owner,
      teamId: fx.teamId,
      projectId: null,
      params,
    });
    const projectRoot = await getRootDrive({
      principal: owner,
      teamId: fx.teamId,
      projectId,
      params,
    });
    expect(teamRoot.children.data.map((item) => item.data.id)).toEqual([
      teamFolder.id,
      teamFile.id,
    ]);
    expect(teamRoot.project).toBeNull();
    expect(projectRoot.children.data.map((item) => item.data.id)).toEqual([
      projectFolder.id,
      projectFile.id,
    ]);
    expect(projectRoot.project).toEqual({ id: projectId, name: "Acme case" });

    // Each item names its own place: what "Move to project" starts from.
    const placeOf = (items: typeof teamRoot.children.data) =>
      items.map((item) => item.data.projectId);
    expect(placeOf(teamRoot.children.data)).toEqual([null, null]);
    expect(placeOf(projectRoot.children.data)).toEqual([projectId, projectId]);
  });
});

describe("moving into and out of a project", () => {
  test("a folder moves with everything in it, and its search audience follows", async () => {
    const root = await folderIn({ name: "Archive" });
    const sub = await folderIn({ name: "2024", parentFolderId: root.id });
    const file = await documentIn({ folderId: sub.id });
    // One chunk in the assistant's index, to watch its audience move.
    await db.insert(aiVectors).values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      sourceType: "documents",
      sourceId: file.id,
      chunkIndex: 0,
      totalChunks: 1,
      content: "a chunk",
      contextualPrefix: "",
      metadata: {
        file_name: file.originalFilename,
        file_type: "application/pdf",
        page_count: 1,
        document_language: null,
        document_summary: null,
        entities: [],
        custom_fields: {},
      },
    });

    await moveToProject({
      principal: await fx.principalOf(ownerId),
      type: "folder",
      id: root.id,
      projectId,
    });
    expect(await projectOf("folder", root.id)).toBe(projectId);
    expect(await projectOf("folder", sub.id)).toBe(projectId);
    expect(await projectOf("document", file.id)).toBe(projectId);
    const [vector] = await db
      .select({ acl: aiVectors.aclPrincipals })
      .from(aiVectors)
      .where(eq(aiVectors.sourceId, file.id));
    expect(vector?.acl).toContain(projectId);

    await moveToProject({
      principal: await fx.principalOf(ownerId),
      type: "folder",
      id: root.id,
      projectId: null,
    });
    expect(await projectOf("document", file.id)).toBeNull();
    const [back] = await db
      .select({ acl: aiVectors.aclPrincipals })
      .from(aiVectors)
      .where(eq(aiVectors.sourceId, file.id));
    // Simply its team's again.
    expect(back?.acl).toBeNull();
  });

  test("takes full access on the item, taking part in the project, and the item's own team", async () => {
    const teamFolder = await folderIn({ name: "Team", by: memberId });
    // The outsider takes part in the project but has nothing on the folder.
    expect(
      await refusal(
        moveToProject({
          principal: await fx.principalOf(outsiderId),
          type: "folder",
          id: teamFolder.id,
          projectId,
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });

    const otherTeamProject = await createProject({
      principal: await fx.principalOf(outsiderId),
      teamId: otherTeamId,
      project: { name: "Elsewhere", description: "", restricted: false },
    });
    await shareResource({
      principal: await fx.principalOf(outsiderId),
      type: "project",
      id: otherTeamProject.id,
      principals: [{ type: "user", id: memberId }],
      level: "use",
    });
    expect(
      await refusal(
        moveToProject({
          principal: await fx.principalOf(memberId),
          type: "folder",
          id: teamFolder.id,
          projectId: otherTeamProject.id,
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("a Drive move across the project's edge takes full access; inside it, edit is enough", async () => {
    const projectFolder = await folderIn({
      name: "Project",
      projectId,
      by: ownerId,
    });
    const teamFolder = await folderIn({ name: "Team", by: ownerId });
    const file = await documentIn({ folderId: teamFolder.id, by: ownerId });
    // The member edits the file (their team's content) without owning it.
    const member = await fx.principalOf(memberId);
    expect((await resolveAccess(member, "document", file.id))?.level).toBe(
      "full",
    );

    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: projectId,
      principals: [{ type: "user", id: memberId }],
      level: "edit",
    });
    // Moving the team's file into the project changes who reaches it.
    await requireDriveMove(await fx.principalOf(memberId), {
      type: "document",
      id: file.id,
      folderId: projectFolder.id,
    });
    await updateDocument({
      id: file.id,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      updates: { folderId: projectFolder.id },
    });
    expect(await projectOf("document", file.id)).toBe(projectId);

    // Now the project's file, at edit only for the member: moving it out is
    // refused, moving it inside the project is not.
    const inside = await folderIn({
      name: "Inside",
      parentFolderId: projectFolder.id,
      by: memberId,
    });
    await db
      .update(documents)
      .set({ ownerUserId: ownerId })
      .where(eq(documents.id, file.id));
    const memberNow = await fx.principalOf(memberId);
    expect((await resolveAccess(memberNow, "document", file.id))?.level).toBe(
      "edit",
    );
    await requireDriveMove(memberNow, {
      type: "document",
      id: file.id,
      folderId: inside.id,
    });
    expect(
      await refusal(
        requireDriveMove(memberNow, {
          type: "document",
          id: file.id,
          folderId: teamFolder.id,
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });

  test("a folder never moves into itself or one of its own folders", async () => {
    const root = await folderIn({ name: "Root" });
    const child = await folderIn({ name: "Child", parentFolderId: root.id });
    expect(
      await refusal(
        updateFolder({
          id: root.id,
          teamId: fx.teamId,
          updates: { parentFolderId: child.id },
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("renaming a folder rewrites the paths below it, and only those", async () => {
    const lookalike = await folderIn({ name: "axb" });
    const lookalikeChild = await folderIn({
      name: "kept",
      parentFolderId: lookalike.id,
    });
    const renamed = await folderIn({ name: "a_b" });
    const renamedChild = await folderIn({
      name: "moved",
      parentFolderId: renamed.id,
    });

    await updateFolder({
      id: renamed.id,
      teamId: fx.teamId,
      updates: { name: "Renamed" },
    });
    const rows = await db
      .select({ id: folders.id, fullPath: folders.fullPath })
      .from(folders)
      .where(inArray(folders.id, [lookalikeChild.id, renamedChild.id]));
    expect(new Map(rows.map((row) => [row.id, row.fullPath]))).toEqual(
      new Map([
        [lookalikeChild.id, "/axb/kept"],
        [renamedChild.id, "/Renamed/moved"],
      ]),
    );
  });
});

describe("what a project holds, listed and searched", () => {
  test("a project's pages are listed on their own, and in the team's list", async () => {
    const inProject = await fx.createPage({ projectId, ownerUserId: ownerId });
    const inTeam = await fx.createPage({ ownerUserId: ownerId });
    const owner = await fx.principalOf(ownerId);

    const projectPages = await listPages({
      teamId: fx.teamId,
      principal: owner,
      projectId,
    });
    expect(projectPages.map((page) => page.id)).toEqual([inProject.id]);
    expect(projectPages[0]?.projectId).toBe(projectId);
    const teamPages = await listPages({ teamId: fx.teamId, principal: owner });
    expect(teamPages.map((page) => page.id).sort()).toEqual(
      [inProject.id, inTeam.id].sort(),
    );
  });

  test("what a project holds names the project as its search audience, not its team", async () => {
    const file = await documentIn({ folderId: null, projectId });
    const node = (await adapterFor("document").loadNodes([file.id])).get(
      file.id,
    );
    expect(node).toBeDefined();
    const acl = aclOfNode(node!);
    expect(acl).toContain(projectId);
    expect(acl).not.toContain(fx.teamId);

    const teamFile = await documentIn({ folderId: null });
    const teamNode = (
      await adapterFor("document").loadNodes([teamFile.id])
    ).get(teamFile.id);
    expect(aclOfNode(teamNode!)).toBeNull();
  });

  test("a member of the team who is not in a restricted project reaches none of it", async () => {
    const viewerLike = await fx.addPerson();
    const file = await documentIn({ folderId: null, projectId });
    expect(
      await resolveAccess(
        await fx.principalOf(viewerLike),
        "document",
        file.id,
      ),
    ).toBeNull();
    const [row] = await db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(and(eq(documents.id, file.id), eq(documents.teamId, fx.teamId)));
    expect(row?.projectId).toBe(projectId);
  });
});
