import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { resolveAccess } from "../../../src/authz/access";
import db from "../../../src/db";
import {
  accessAuditLog,
  accessGrants,
  aiConversations,
  documents,
  folders,
  pages,
  projects,
  teamMember,
  teamMemberRoles,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import type { CreateProjectInput } from "../../../src/schemas/projects";
import { listSharedWithMe } from "../../../src/services/access/sharing/list-shared-with-me";
import { setGeneralAccess } from "../../../src/services/access/sharing/set-general-access";
import { shareResource } from "../../../src/services/access/sharing/share";
import { updateOrganizationPolicy } from "../../../src/services/access/update-organization-policy";
import { setProjectArchived } from "../../../src/services/projects/archive";
import { createProject } from "../../../src/services/projects/create";
import { deleteProject } from "../../../src/services/projects/delete";
import { listProjectPeople } from "../../../src/services/projects/people";
import { getProject, listProjects } from "../../../src/services/projects/read";
import { updateProject } from "../../../src/services/projects/update";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * A project from creation to deletion: who creates one, who reaches it and at
 * what level, what its members may change, archiving it, and deleting it
 * without deleting what it holds or opening it to anyone.
 *
 * The fixture's owner is an organization owner and a plain member of the
 * team (no role row); `member` is a member of the team; `viewer` is made a
 * team viewer here; `outsider` is in another team of the organization.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;
let viewerId: string;
let outsiderId: string;
let otherTeamId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  viewerId = await fx.addPerson();
  const [seat] = await db
    .select({ id: teamMember.id })
    .from(teamMember)
    .where(
      and(eq(teamMember.teamId, fx.teamId), eq(teamMember.userId, viewerId)),
    );
  await db.insert(teamMemberRoles).values({
    teamMemberId: seat!.id,
    teamId: fx.teamId,
    userId: viewerId,
    role: "viewer",
  });
  otherTeamId = (await fx.createTeam()).id;
  outsiderId = await fx.addPerson({ inTeam: false });
  await db
    .insert(teamMember)
    .values({ userId: outsiderId, teamId: otherTeamId, createdAt: new Date() });
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

const create = async (by: string, project: Partial<CreateProjectInput> = {}) =>
  createProject({
    principal: await fx.principalOf(by),
    teamId: fx.teamId,
    project: {
      name: "Client onboarding",
      description: "",
      restricted: false,
      ...project,
    },
  });

const levelOf = async (userId: string, projectId: string) =>
  (await resolveAccess(await fx.principalOf(userId), "project", projectId))
    ?.level ?? null;

describe("creating a project", () => {
  test("a member creates one in their team, owns it, and the journal says so", async () => {
    const project = await create(memberId);

    expect(project).toMatchObject({
      teamId: fx.teamId,
      name: "Client onboarding",
      restricted: false,
      ownerUserId: memberId,
      level: "full",
      archivedAt: null,
    });
    expect(project.owner?.userId).toBe(memberId);
    const journal = await db
      .select({ action: accessAuditLog.action })
      .from(accessAuditLog)
      .where(eq(accessAuditLog.resourceId, project.id));
    expect(journal.map((entry) => entry.action)).toEqual(["project.created"]);
  });

  test("a viewer does not, nor anyone once the policy keeps it to admins", async () => {
    expect(await refusal(create(viewerId))).toEqual({
      status: 403,
      code: "ACCESS_DENIED",
    });
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { projectCreation: "admins" },
    });
    expect(await refusal(create(memberId))).toEqual({
      status: 403,
      code: "ACCESS_DENIED",
    });
    // The organization's owner is one of its admins.
    expect((await create(ownerId)).level).toBe("full");
  });
});

describe("who reaches a project", () => {
  test("open, the team reaches it by role; restricted, only its members", async () => {
    const project = await create(ownerId);
    expect(await levelOf(memberId, project.id)).toBe("edit");
    expect(await levelOf(viewerId, project.id)).toBe("view");
    expect(await levelOf(outsiderId, project.id)).toBeNull();

    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: project.id,
      restricted: true,
    });
    expect(await levelOf(memberId, project.id)).toBeNull();
    expect(await levelOf(viewerId, project.id)).toBeNull();
    expect(await levelOf(ownerId, project.id)).toBe("full");
  });

  test("a member from another team is given it by name, and finds it in their lists and on Shared with me", async () => {
    const project = await create(ownerId, { restricted: true });
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: project.id,
      principals: [{ type: "user", id: outsiderId }],
      level: "use",
    });

    const outsider = await fx.principalOf(outsiderId);
    expect(outsider.projectLevels.get(project.id)).toBe("use");
    const listed = await listProjects({ principal: outsider });
    expect(listed.map((row) => [row.id, row.level, row.teamId])).toEqual([
      [project.id, "use", fx.teamId],
    ]);
    const shared = await listSharedWithMe(outsider);
    expect(
      shared.items.map((item) => [item.resource.type, item.resource.id]),
    ).toEqual([["project", project.id]]);
  });

  test("everyone who reaches it, with their level, whatever the path", async () => {
    const project = await create(ownerId);
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: project.id,
      principals: [{ type: "team", id: otherTeamId }],
      level: "use",
    });

    const people = await listProjectPeople({
      principal: await fx.principalOf(memberId),
      projectId: project.id,
    });
    expect(
      new Map(people.map((person) => [person.userId, person.level])),
    ).toEqual(
      new Map([
        [ownerId, "full"],
        [memberId, "edit"],
        [viewerId, "view"],
        [outsiderId, "use"],
      ]),
    );
  });
});

describe("changing a project", () => {
  test("its instructions take edit; its settings take full", async () => {
    const project = await create(ownerId);
    const member = await fx.principalOf(memberId);

    const edited = await updateProject({
      principal: member,
      projectId: project.id,
      patch: { instructions: "Answer in the client's language." },
    });
    expect(edited.instructions).toBe("Answer in the client's language.");
    expect(
      await refusal(
        updateProject({
          principal: member,
          projectId: project.id,
          patch: { name: "Renamed" },
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    expect(
      await refusal(
        updateProject({
          principal: await fx.principalOf(viewerId),
          projectId: project.id,
          patch: { instructions: "…" },
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });

    const renamed = await updateProject({
      principal: await fx.principalOf(ownerId),
      projectId: project.id,
      patch: { name: "Renamed", icon: "briefcase", color: "teal" },
    });
    expect(renamed).toMatchObject({
      name: "Renamed",
      icon: "briefcase",
      color: "teal",
    });
  });

  test("archived, it leaves the lists and changes nothing until restored", async () => {
    const project = await create(ownerId);
    const owner = await fx.principalOf(ownerId);

    await setProjectArchived({
      principal: owner,
      projectId: project.id,
      archived: true,
    });
    const member = await fx.principalOf(memberId);
    expect(await listProjects({ principal: member })).toEqual([]);
    expect(
      (await listProjects({ principal: member, includeArchived: true })).map(
        (row) => row.id,
      ),
    ).toEqual([project.id]);
    // Still readable by link.
    expect(
      (await getProject({ principal: member, projectId: project.id }))
        .archivedAt,
    ).not.toBeNull();
    expect(
      await refusal(
        updateProject({
          principal: member,
          projectId: project.id,
          patch: { instructions: "…" },
        }),
      ),
    ).toEqual({ status: 409, code: "PROJECT_ARCHIVED" });

    await setProjectArchived({
      principal: owner,
      projectId: project.id,
      archived: false,
    });
    expect((await listProjects({ principal: member })).length).toBe(1);
  });
});

describe("deleting a project", () => {
  test("takes full access", async () => {
    const project = await create(ownerId);
    expect(
      await refusal(
        deleteProject({
          principal: await fx.principalOf(memberId),
          projectId: project.id,
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });

  test("from an open project, everything goes back to the team as it was; chats stay with their people", async () => {
    const project = await create(ownerId);
    const [folder] = await db
      .insert(folders)
      .values({
        name: "Contracts",
        fullPath: "/Contracts",
        teamId: fx.teamId,
        projectId: project.id,
        createdById: memberId,
      })
      .returning({ id: folders.id });
    const [document] = await db
      .insert(documents)
      .values({
        teamId: fx.teamId,
        projectId: project.id,
        folderId: folder!.id,
        status: "ready",
        originalFilename: "contract.pdf",
        fileSize: 1,
        mimeType: "application/pdf",
        fileHash: crypto.randomUUID(),
        uploadedById: memberId,
      })
      .returning({ id: documents.id });
    const page = await fx.createPage({ projectId: project.id });
    const chat = await fx.createConversation({
      projectId: project.id,
      userId: memberId,
      accessRestricted: false,
    });

    const released = await deleteProject({
      principal: await fx.principalOf(ownerId),
      projectId: project.id,
    });
    expect(released).toEqual({
      conversations: 1,
      folders: 1,
      documents: 1,
      pages: 1,
      workflows: 0,
    });

    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toEqual([]);
    const [folderRow] = await db
      .select({
        projectId: folders.projectId,
        restricted: folders.accessRestricted,
      })
      .from(folders)
      .where(eq(folders.id, folder!.id));
    expect(folderRow).toEqual({ projectId: null, restricted: false });
    const [documentRow] = await db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, document!.id));
    expect(documentRow?.projectId).toBeNull();
    const [pageRow] = await db
      .select({
        projectId: pages.projectId,
        restricted: pages.accessRestricted,
      })
      .from(pages)
      .where(eq(pages.id, page.id));
    expect(pageRow).toEqual({ projectId: null, restricted: false });
    const [chatRow] = await db
      .select({
        projectId: aiConversations.projectId,
        restricted: aiConversations.accessRestricted,
      })
      .from(aiConversations)
      .where(eq(aiConversations.id, chat.id));
    expect(chatRow).toEqual({ projectId: null, restricted: true });

    // The team reads the folder as it read it through the open project.
    expect(
      (
        await resolveAccess(
          await fx.principalOf(viewerId),
          "folder",
          folder!.id,
        )
      )?.level,
    ).toBe("view");
    const journal = await db
      .select({
        action: accessAuditLog.action,
        metadata: accessAuditLog.metadata,
      })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.resourceId, project.id),
          eq(accessAuditLog.action, "project.deleted"),
        ),
      );
    expect(journal[0]?.metadata).toMatchObject({ documents: 1, pages: 1 });
  });

  test("from a restricted project, nobody gains: what was open to it is kept to its owner, and its members lose it", async () => {
    const project = await create(ownerId, { restricted: true });
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: project.id,
      principals: [{ type: "user", id: outsiderId }],
      level: "use",
    });
    const [folder] = await db
      .insert(folders)
      .values({
        name: "Private notes",
        fullPath: "/Private notes",
        teamId: fx.teamId,
        projectId: project.id,
        createdById: ownerId,
      })
      .returning({ id: folders.id });
    const page = await fx.createPage({
      projectId: project.id,
      ownerUserId: ownerId,
    });
    // Something of the team shared WITH the project.
    const teamPage = await fx.createPage({ ownerUserId: ownerId });
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "page",
      id: teamPage.id,
      principals: [{ type: "project", id: project.id }],
      level: "view",
    });

    expect(await levelOf(outsiderId, project.id)).toBe("use");
    await deleteProject({
      principal: await fx.principalOf(ownerId),
      projectId: project.id,
    });

    const member = await fx.principalOf(memberId);
    const outsider = await fx.principalOf(outsiderId);
    expect(await resolveAccess(member, "folder", folder!.id)).toBeNull();
    expect(await resolveAccess(member, "page", page.id)).toBeNull();
    expect(await resolveAccess(outsider, "folder", folder!.id)).toBeNull();
    expect(outsider.projectLevels.size).toBe(0);
    expect(
      (await resolveAccess(await fx.principalOf(ownerId), "folder", folder!.id))
        ?.level,
    ).toBe("full");
    // The grant to the project went with it.
    expect(
      await db
        .select({ id: accessGrants.id })
        .from(accessGrants)
        .where(eq(accessGrants.principalId, project.id)),
    ).toEqual([]);
    const [pageRow] = await db
      .select({ restricted: pages.accessRestricted, userId: pages.userId })
      .from(pages)
      .where(eq(pages.id, page.id));
    expect(pageRow).toEqual({ restricted: true, userId: ownerId });
  });
});
