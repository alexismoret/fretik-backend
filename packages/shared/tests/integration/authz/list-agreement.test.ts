import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { resolveAccessMany } from "../../../src/authz/access";
import { atLeast } from "../../../src/authz/levels";
import type { UserPrincipal } from "../../../src/authz/principal";
import db from "../../../src/db";
import {
  accessGrants,
  member,
  pages,
  projects,
  teamMember,
  teamMemberRoles,
  user,
  workflows,
} from "../../../src/db/schema";
import { ACCESS_LEVELS, type AccessLevel } from "../../../src/schemas/access";
import { EMPTY_PAGE_DEFINITION } from "../../../src/schemas/pages";
import { pageAccessWhere } from "../../../src/services/pages/visibility";
import { workflowAccessWhere } from "../../../src/services/workflows/visibility";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The access rules exist twice: as `computeLevel`, which decides one resource
 * at a time (`authz/rules.ts`), and as SQL, which filters a list in one query
 * (`authz/sql.ts`). They must give the same answers, or a page shows up in a
 * list and then refuses to open — or, worse, opens and never shows up.
 *
 * So both are asked the same question over the same rows: for each person and
 * each level, which of these pages (and workflows) do they reach? The rows
 * cover every path the rules know — ownership in both the legacy and the new
 * columns, grants to a person, a team, a project and the organization, an
 * expired grant, the team and the project as containers, a restricted
 * project, a team viewer — and the people cover every standing: the
 * organization's owner, a member, a viewer, and someone from another team
 * who reaches one project by a grant.
 *
 * A few anchors are asserted by hand as well, so the agreement cannot be the
 * agreement of two engines that both see nothing.
 */

let fx: WorkspaceFixture;
let otherTeamId: string;
/** The organization's owner and a member, both in the team. */
let owner: string;
let memberId: string;
/** A viewer of the team, and someone who is only in the other team. */
let viewer: string;
let outsider: string;

const pageIds = new Map<string, string>();
const workflowIds = new Map<string, string>();

const PLAYBOOK = {
  goal: "hold access facts",
  tasks: [{ key: "t", title: "T", description: "", instructions: "i" }],
};

/** An extra person in the workspace's organization, in the given team. */
const addPerson = async (
  name: string,
  teamId: string,
  role: "member" | "viewer",
): Promise<string> => {
  const [row] = await db
    .insert(user)
    .values({
      name,
      email: `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`,
      emailVerified: true,
    })
    .returning({ id: user.id });
  if (!row) throw new Error("fixture: no user");
  await db.insert(member).values({
    userId: row.id,
    organizationId: fx.organizationId,
    role: "member",
    createdAt: new Date(),
  });
  const [seat] = await db
    .insert(teamMember)
    .values({ userId: row.id, teamId, createdAt: new Date() })
    .returning({ id: teamMember.id });
  if (!seat) throw new Error("fixture: no team seat");
  if (role === "viewer") {
    await db
      .insert(teamMemberRoles)
      .values({ teamMemberId: seat.id, teamId, userId: row.id, role });
  }
  return row.id;
};

const grant = async (input: {
  resourceType: "page" | "workflow" | "project";
  resourceId: string;
  principalType: "user" | "team" | "project" | "organization";
  principalId: string;
  level: AccessLevel;
  expiresAt?: Date;
}): Promise<void> => {
  await db.insert(accessGrants).values({
    organizationId: fx.organizationId,
    ...input,
  });
};

const addProject = async (input: {
  name: string;
  restricted: boolean;
}): Promise<string> => {
  const [row] = await db
    .insert(projects)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      name: input.name,
      ownerUserId: owner,
      accessRestricted: input.restricted,
    })
    .returning({ id: projects.id });
  if (!row) throw new Error("fixture: no project");
  return row.id;
};

/** One row of each kind, as every writer of these tables has left them. */
interface Shape {
  teamId?: string;
  projectId?: string;
  /** The legacy privacy column: set = private to that person. */
  userId?: string;
  ownerUserId?: string;
  accessRestricted?: boolean;
  createdByUserId?: string;
}

const addPage = async (key: string, shape: Shape): Promise<string> => {
  const [row] = await db
    .insert(pages)
    .values({
      organizationId: fx.organizationId,
      teamId: shape.teamId ?? fx.teamId,
      projectId: shape.projectId ?? null,
      userId: shape.userId ?? null,
      ownerUserId: shape.ownerUserId ?? null,
      accessRestricted: shape.accessRestricted ?? false,
      createdByUserId: shape.createdByUserId ?? owner,
      name: key,
      definition: EMPTY_PAGE_DEFINITION,
    })
    .returning({ id: pages.id });
  if (!row) throw new Error("fixture: no page");
  pageIds.set(key, row.id);
  return row.id;
};

const addWorkflow = async (key: string, shape: Shape): Promise<string> => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: shape.teamId ?? fx.teamId,
      projectId: shape.projectId ?? null,
      userId: shape.userId ?? null,
      ownerUserId: shape.ownerUserId ?? null,
      accessRestricted: shape.accessRestricted ?? false,
      createdByUserId: shape.createdByUserId ?? owner,
      name: key,
      triggerType: "manual",
      playbook: PLAYBOOK,
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("fixture: no workflow");
  workflowIds.set(key, row.id);
  return row.id;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [owner, memberId] = fx.userIds;
  otherTeamId = (await fx.createTeam()).id;
  viewer = await addPerson("viewer", fx.teamId, "viewer");
  outsider = await addPerson("outsider", otherTeamId, "member");

  const openProject = await addProject({ name: "open", restricted: false });
  const closedProject = await addProject({ name: "closed", restricted: true });
  await grant({
    resourceType: "project",
    resourceId: closedProject,
    principalType: "user",
    principalId: outsider,
    level: "edit",
  });

  // The same shapes for both flat types; the workflow ceiling makes the same
  // grants mean less on a restricted workflow, which is part of the question.
  for (const add of [addPage, addWorkflow]) {
    const type = add === addPage ? "page" : "workflow";
    await add("open", {});
    await add("legacy-private-owner", { userId: owner });
    await add("legacy-private-member", {
      userId: memberId,
      createdByUserId: memberId,
    });
    await add("restricted-member", {
      userId: memberId,
      ownerUserId: memberId,
      accessRestricted: true,
      createdByUserId: memberId,
    });
    await add("restricted-no-legacy", {
      ownerUserId: memberId,
      accessRestricted: true,
      createdByUserId: memberId,
    });
    const toMember = await add("private-granted-member", { userId: owner });
    await grant({
      resourceType: type,
      resourceId: toMember,
      principalType: "user",
      principalId: memberId,
      level: "edit",
    });
    const toTeam = await add("private-granted-team", { userId: owner });
    await grant({
      resourceType: type,
      resourceId: toTeam,
      principalType: "team",
      principalId: fx.teamId,
      level: "edit",
    });
    const toOrg = await add("private-granted-org", { userId: owner });
    await grant({
      resourceType: type,
      resourceId: toOrg,
      principalType: "organization",
      principalId: fx.organizationId,
      level: "view",
    });
    const toProject = await add("private-granted-project", { userId: owner });
    await grant({
      resourceType: type,
      resourceId: toProject,
      principalType: "project",
      principalId: openProject,
      level: "use",
    });
    const expired = await add("private-expired-grant", { userId: owner });
    await grant({
      resourceType: type,
      resourceId: expired,
      principalType: "user",
      principalId: memberId,
      level: "full",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await add("other-team", { teamId: otherTeamId, createdByUserId: outsider });
    await add("in-open-project", { projectId: openProject });
    await add("in-closed-project", { projectId: closedProject });
  }
});

afterAll(async () => {
  await db.delete(user).where(inArray(user.id, [viewer, outsider]));
  await fx.cleanup();
});

/** Every person the rows are asked about, loaded as the engine loads them. */
const people = async (): Promise<[string, UserPrincipal][]> => [
  ["owner", await fx.principalOf(owner)],
  ["member", await fx.principalOf(memberId)],
  ["viewer", await fx.principalOf(viewer)],
  ["outsider", await fx.principalOf(outsider)],
];

const nameOf = (ids: Map<string, string>, id: string): string =>
  [...ids].find(([, value]) => value === id)?.[0] ?? id;

/** What the one-at-a-time engine says, as sorted row names. */
const byEngine = async (
  principal: UserPrincipal,
  type: "page" | "workflow",
  ids: Map<string, string>,
  level: AccessLevel,
): Promise<string[]> => {
  const resolved = await resolveAccessMany(principal, type, [...ids.values()]);
  return [...resolved]
    .filter(([, resource]) => atLeast(resource.level, level))
    .map(([id]) => nameOf(ids, id))
    .sort();
};

const bySqlPages = async (
  principal: UserPrincipal,
  level: AccessLevel,
): Promise<string[]> =>
  (
    await db.query.pages.findMany({
      columns: { id: true },
      where: {
        id: { in: [...pageIds.values()] },
        ...pageAccessWhere(principal, level),
      },
    })
  )
    .map((row) => nameOf(pageIds, row.id))
    .sort();

const bySqlWorkflows = async (
  principal: UserPrincipal,
  level: AccessLevel,
): Promise<string[]> =>
  (
    await db.query.workflows.findMany({
      columns: { id: true },
      where: {
        id: { in: [...workflowIds.values()] },
        ...workflowAccessWhere(principal, level),
      },
    })
  )
    .map((row) => nameOf(workflowIds, row.id))
    .sort();

describe("the SQL filters agree with the rules", () => {
  test("pages: every person, every level", async () => {
    for (const [who, principal] of await people()) {
      for (const level of ACCESS_LEVELS) {
        const expected = await byEngine(principal, "page", pageIds, level);
        const listed = await bySqlPages(principal, level);
        expect({ who, level, listed }).toEqual({
          who,
          level,
          listed: expected,
        });
      }
    }
  });

  test("workflows: every person, every level, with the restricted ceiling", async () => {
    for (const [who, principal] of await people()) {
      for (const level of ACCESS_LEVELS) {
        const expected = await byEngine(
          principal,
          "workflow",
          workflowIds,
          level,
        );
        const listed = await bySqlWorkflows(principal, level);
        expect({ who, level, listed }).toEqual({
          who,
          level,
          listed: expected,
        });
      }
    }
  });
});

describe("anchors — what the agreement is about", () => {
  const levelOf = async (
    principal: UserPrincipal,
    type: "page" | "workflow",
    key: string,
  ): Promise<AccessLevel | null> => {
    const ids = type === "page" ? pageIds : workflowIds;
    const id = ids.get(key) ?? "";
    return (
      (await resolveAccessMany(principal, type, [id])).get(id)?.level ?? null
    );
  };

  test("the organization's owner gets nothing on a member's private work", async () => {
    const ownerP = await fx.principalOf(owner);
    expect(await levelOf(ownerP, "page", "legacy-private-member")).toBeNull();
    expect(await levelOf(ownerP, "page", "restricted-no-legacy")).toBeNull();
    expect(await levelOf(ownerP, "page", "legacy-private-owner")).toBe("full");
  });

  test("a grant opens a private page, an expired one does not", async () => {
    const memberP = await fx.principalOf(memberId);
    expect(await levelOf(memberP, "page", "private-granted-member")).toBe(
      "edit",
    );
    expect(await levelOf(memberP, "page", "private-expired-grant")).toBeNull();
    expect(await levelOf(memberP, "page", "private-granted-org")).toBe("view");
  });

  test("a restricted workflow stays at view for anyone but its owner", async () => {
    const memberP = await fx.principalOf(memberId);
    expect(await levelOf(memberP, "workflow", "private-granted-member")).toBe(
      "view",
    );
    expect(await levelOf(memberP, "workflow", "restricted-member")).toBe(
      "full",
    );
  });

  test("a team viewer reads the team's content and a team grant, never more", async () => {
    const viewerP = await fx.principalOf(viewer);
    expect(await levelOf(viewerP, "page", "open")).toBe("view");
    expect(await levelOf(viewerP, "page", "private-granted-team")).toBe("view");
    expect(await levelOf(viewerP, "page", "in-open-project")).toBe("view");
  });

  test("someone from another team reaches one project by its grant, and nothing else of the team", async () => {
    const outsiderP = await fx.principalOf(outsider);
    expect(await levelOf(outsiderP, "page", "in-closed-project")).toBe("edit");
    expect(await levelOf(outsiderP, "page", "open")).toBeNull();
    expect(await levelOf(outsiderP, "page", "other-team")).toBe("full");
    // A member of the team reaches the open project, not the closed one.
    const memberP = await fx.principalOf(memberId);
    expect(await levelOf(memberP, "page", "in-open-project")).toBe("edit");
    expect(await levelOf(memberP, "page", "in-closed-project")).toBeNull();
  });

  test("a project grant reaches its members, capped by their place in it", async () => {
    // `use` granted to the open project: a member of the team edits the
    // project, and takes part in what is granted to it.
    const memberP = await fx.principalOf(memberId);
    expect(await levelOf(memberP, "page", "private-granted-project")).toBe(
      "use",
    );
    const viewerP = await fx.principalOf(viewer);
    expect(await levelOf(viewerP, "page", "private-granted-project")).toBe(
      "view",
    );
  });
});
