import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { hasCapability } from "../../../src/authz/gates";
import { loadPrincipal } from "../../../src/authz/load-principal";
import db from "../../../src/db";
import {
  accessAuditLog,
  member,
  organizationSettings,
  team,
  teamMember,
} from "../../../src/db/schema";
import { MAX_MEMBERS_PER_TEAM } from "../../../src/lib/auth-constants";
import { parseApiError } from "../../../src/schemas/errors";
import { describeAccess } from "../../../src/services/access/describe";
import { updateOrganizationPolicy } from "../../../src/services/access/update-organization-policy";
import { listOrganizationMembers } from "../../../src/services/members/directory";
import { removeOrganizationMember } from "../../../src/services/members/remove";
import { setOrganizationRole } from "../../../src/services/members/set-role";
import { addTeamMembers } from "../../../src/services/team/add-members";
import { createTeam } from "../../../src/services/team/create";
import { getTeamDetail } from "../../../src/services/team/detail";
import { removeTeamMember } from "../../../src/services/team/remove-member";
import { renameTeam } from "../../../src/services/team/rename";
import { setTeamPolicy } from "../../../src/services/team/set-policy";
import { setTeamMemberRole } from "../../../src/services/team/set-role";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * Teams and people, as the settings manage them: who creates a team, who
 * joins it with which role, who leaves, who becomes an admin — and the
 * journal entry each change leaves.
 *
 * Every test builds its own workspace (order is randomized): an organization
 * whose OWNER and MEMBER share one team the fixture wrote by hand. A team
 * made through `createTeam` is a real one — agent account, settings row,
 * its creator as lead — which is what the team-level rules need.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
});

afterEach(async () => {
  await fx.cleanup();
});

/** A refusal's status and code. */
const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

const journal = async (action: string) =>
  db
    .select()
    .from(accessAuditLog)
    .where(
      and(
        eq(accessAuditLog.organizationId, fx.organizationId),
        eq(accessAuditLog.action, action),
      ),
    );

/** A real team, created by the organization's owner, who leads it. */
const ownersTeam = async (name = "Operations"): Promise<string> => {
  const created = await createTeam({
    principal: await fx.principalOf(ownerId),
    name,
  });
  return created.id;
};

const agentOf = async (teamId: string): Promise<string> => {
  const row = await db.query.teamSettings.findFirst({
    columns: { botUserId: true },
    where: { teamId },
  });
  if (!row) throw new Error("the team has no settings row");
  return row.botUserId;
};

describe("creating a team", () => {
  test("an admin creates a team and leads it, with its agent set up", async () => {
    const created = await createTeam({
      principal: await fx.principalOf(ownerId),
      name: "Operations",
    });

    expect(created).toMatchObject({
      name: "Operations",
      memberCount: 1,
      role: "lead",
    });
    const settings = await db.query.teamSettings.findFirst({
      where: { teamId: created.id },
    });
    expect(settings?.botUserId).toBeString();
    const detail = await getTeamDetail({
      principal: await fx.principalOf(ownerId),
      teamId: created.id,
    });
    // The agent is in the team, and in no roster.
    expect(detail.members.map((m) => [m.userId, m.role])).toEqual([
      [ownerId, "lead"],
    ]);
    const [entry] = await journal("team.created");
    expect(entry?.actorUserId).toBe(ownerId);
    expect(entry?.metadata).toEqual({ teamName: "Operations" });
  });

  test("a member is refused until the organization opens team creation", async () => {
    expect(
      await refusal(
        createTeam({ principal: await fx.principalOf(memberId), name: "Mine" }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });

    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { teamCreation: "members" },
    });
    const created = await createTeam({
      principal: await fx.principalOf(memberId),
      name: "Mine",
    });

    expect(created.role).toBe("lead");
  });

  test("the organization's team limit holds on this door too", async () => {
    await db
      .insert(organizationSettings)
      .values({ organizationId: fx.organizationId, maxAgencies: 1 });

    expect(await refusal(ownersTeam())).toEqual({
      status: 409,
      code: "TEAM_LIMIT_REACHED",
    });
  });
});

describe("a team's people", () => {
  test("a lead adds people of the organization, with a role", async () => {
    const teamId = await ownersTeam();

    const roster = await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "viewer",
    });

    expect(roster.map((m) => [m.userId, m.role])).toEqual([
      [ownerId, "lead"],
      [memberId, "viewer"],
    ]);
    const viewer = await fx.principalOf(memberId);
    expect(viewer.teamRoles.get(teamId)).toBe("viewer");
    // A viewer reads: nothing of the team's is theirs to add to.
    expect(
      await hasCapability({
        principal: viewer,
        capability: "team.content.create",
        teamId,
      }),
    ).toBe(false);
    const [entry] = await journal("team_member.added");
    expect(entry?.principalId).toBe(memberId);
    expect(entry?.metadata).toMatchObject({ teamId, role: "viewer" });
  });

  test("only people of the organization join a team", async () => {
    const teamId = await ownersTeam();

    expect(
      await refusal(
        addTeamMembers({
          principal: await fx.principalOf(ownerId),
          teamId,
          userIds: [crypto.randomUUID()],
          role: "member",
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("a member who does not lead the team changes nobody in it", async () => {
    const teamId = await ownersTeam();
    await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "member",
    });
    const plainMember = await fx.principalOf(memberId);

    expect(
      await refusal(
        setTeamMemberRole({
          principal: plainMember,
          teamId,
          userId: ownerId,
          role: "viewer",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    expect(
      await refusal(
        removeTeamMember({ principal: plainMember, teamId, userId: ownerId }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });

  test("a lead changes a role, and the journal keeps before and after", async () => {
    const teamId = await ownersTeam();
    await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "member",
    });

    await setTeamMemberRole({
      principal: await fx.principalOf(ownerId),
      teamId,
      userId: memberId,
      role: "lead",
    });

    expect((await fx.principalOf(memberId)).teamRoles.get(teamId)).toBe("lead");
    const [entry] = await journal("team_role.changed");
    expect(entry?.metadata).toMatchObject({ from: "member", to: "lead" });
  });

  test("anyone may leave a team, and stays in the organization", async () => {
    const teamId = await ownersTeam();
    await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "member",
    });

    const roster = await removeTeamMember({
      principal: await fx.principalOf(memberId),
      teamId,
      userId: memberId,
    });

    expect(roster.map((m) => m.userId)).toEqual([ownerId]);
    const left = await fx.principalOf(memberId);
    expect(left.teamRoles.has(teamId)).toBe(false);
    expect(left.teamRoles.has(fx.teamId)).toBe(true);
    const [entry] = await journal("team_member.removed");
    expect(entry?.metadata).toMatchObject({ left: true, role: "member" });
  });

  test("the team's agent is given no role and taken out by no one", async () => {
    const teamId = await ownersTeam();
    const agent = await agentOf(teamId);
    const owner = await fx.principalOf(ownerId);

    expect(
      await refusal(
        setTeamMemberRole({
          principal: owner,
          teamId,
          userId: agent,
          role: "lead",
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(
      await refusal(
        removeTeamMember({ principal: owner, teamId, userId: agent }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("the seat limit stops additions, keeping whoever joined before it", async () => {
    const teamId = await ownersTeam();
    const third = await fx.addPerson({ role: "member" });
    // One seat left: the next person takes it, the one after is refused.
    await db
      .update(team)
      .set({ memberCount: MAX_MEMBERS_PER_TEAM - 1 })
      .where(eq(team.id, teamId));

    expect(
      await refusal(
        addTeamMembers({
          principal: await fx.principalOf(ownerId),
          teamId,
          userIds: [memberId, third],
          role: "member",
        }),
      ),
    ).toEqual({ status: 409, code: "TEAM_MEMBER_LIMIT_REACHED" });
    const seats = await db
      .select({ userId: teamMember.userId })
      .from(teamMember)
      .where(eq(teamMember.teamId, teamId));
    expect(seats.map((s) => s.userId)).toContain(memberId);
    expect(seats.map((s) => s.userId)).not.toContain(third);
  });
});

describe("a team's name and defaults", () => {
  test("its leads rename it; its members do not", async () => {
    const teamId = await ownersTeam("Old name");
    await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "member",
    });

    expect(
      await refusal(
        renameTeam({
          principal: await fx.principalOf(memberId),
          teamId,
          name: "Taken over",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    await renameTeam({
      principal: await fx.principalOf(ownerId),
      teamId,
      name: "New name",
    });

    const row = await db.query.team.findFirst({ where: { id: teamId } });
    expect(row?.name).toBe("New name");
    const [entry] = await journal("team.renamed");
    expect(entry?.metadata).toEqual({ from: "Old name", to: "New name" });
  });

  test("what a member gets on the team's content reaches their access, stored sparse", async () => {
    const teamId = await ownersTeam();
    await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "member",
    });

    const policy = await setTeamPolicy({
      principal: await fx.principalOf(ownerId),
      teamId,
      patch: { memberContentLevel: "edit" },
    });

    expect(policy).toEqual({ memberContentLevel: "edit" });
    expect((await fx.principalOf(memberId)).teamContentLevels.get(teamId)).toBe(
      "edit",
    );
    const stored = await db.query.teamSettings.findFirst({
      columns: { accessPolicy: true },
      where: { teamId },
    });
    expect(stored?.accessPolicy).toEqual({ memberContentLevel: "edit" });
    const [entry] = await journal("team_policy.updated");
    expect(entry?.metadata).toMatchObject({
      changes: [{ setting: "memberContentLevel", from: "full", to: "edit" }],
    });
  });
});

describe("the organization's people", () => {
  test("the directory lists people with their teams and roles, never an agent", async () => {
    const teamId = await ownersTeam("Operations");
    await addTeamMembers({
      principal: await fx.principalOf(ownerId),
      teamId,
      userIds: [memberId],
      role: "viewer",
    });

    const people = await listOrganizationMembers(fx.organizationId);

    expect(people.map((p) => p.userId).sort()).toEqual(
      [ownerId, memberId].sort(),
    );
    const owner = people.find((p) => p.userId === ownerId);
    const viewer = people.find((p) => p.userId === memberId);
    expect(owner?.role).toBe("owner");
    expect(owner?.teams.find((t) => t.teamId === teamId)?.role).toBe("lead");
    expect(viewer?.teams.find((t) => t.teamId === teamId)?.role).toBe("viewer");
    expect(viewer?.teams.find((t) => t.teamId === fx.teamId)?.role).toBe(
      "member",
    );
  });

  test("an admin makes someone an admin, and an admin cannot touch an owner", async () => {
    const promoted = await setOrganizationRole({
      principal: await fx.principalOf(ownerId),
      userId: memberId,
      role: "admin",
    });

    expect(promoted.role).toBe("admin");
    expect((await fx.principalOf(memberId)).isOrgAdmin).toBe(true);
    const [entry] = await journal("member.role_changed");
    expect(entry?.metadata).toMatchObject({ from: "member", to: "admin" });
    expect(
      await refusal(
        setOrganizationRole({
          principal: await fx.principalOf(memberId),
          userId: ownerId,
          role: "member",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("the last owner stays an owner", async () => {
    expect(
      await refusal(
        setOrganizationRole({
          principal: await fx.principalOf(ownerId),
          userId: ownerId,
          role: "member",
        }),
      ),
    ).toEqual({ status: 409, code: "LAST_OWNER" });
  });

  test("a member manages nobody's role", async () => {
    expect(
      await refusal(
        setOrganizationRole({
          principal: await fx.principalOf(memberId),
          userId: memberId,
          role: "admin",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });

  test("removing someone takes them out of every team; leaving is not removing", async () => {
    const owner = await fx.principalOf(ownerId);

    expect(
      await refusal(
        removeOrganizationMember({ principal: owner, userId: ownerId }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    await removeOrganizationMember({ principal: owner, userId: memberId });

    const membership = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, fx.organizationId),
          eq(member.userId, memberId),
        ),
      );
    expect(membership).toEqual([]);
    const seats = await db
      .select()
      .from(teamMember)
      .where(eq(teamMember.userId, memberId));
    expect(seats).toEqual([]);
    expect(
      await loadPrincipal({
        organizationId: fx.organizationId,
        userId: memberId,
      }),
    ).toBeNull();
    const [entry] = await journal("member.removed");
    expect(entry?.principalId).toBe(memberId);
  });
});

describe("the organization's policy", () => {
  test("only admins change it, only what they set is stored, each change journaled once", async () => {
    expect(
      await refusal(
        updateOrganizationPolicy({
          principal: await fx.principalOf(memberId),
          patch: { publicLinks: "leads" },
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });

    const owner = await fx.principalOf(ownerId);
    const policy = await updateOrganizationPolicy({
      principal: owner,
      patch: { publicLinks: "leads" },
    });
    // The same change again changes nothing, and journals nothing.
    await updateOrganizationPolicy({
      principal: owner,
      patch: { publicLinks: "leads" },
    });

    expect(policy.publicLinks).toBe("leads");
    const stored = await db.query.organizationSettings.findFirst({
      columns: { accessPolicy: true },
      where: { organizationId: fx.organizationId },
    });
    expect(stored?.accessPolicy).toEqual({ publicLinks: "leads" });
    const entries = await journal("organization_policy.updated");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toEqual({
      changes: [{ setting: "publicLinks", from: "members", to: "leads" }],
    });
  });
});

describe("describing access", () => {
  test("the caller's standing, and every decision in the active team", async () => {
    const me = await describeAccess({
      principal: await fx.principalOf(memberId),
      activeTeamId: fx.teamId,
    });

    expect(me).toMatchObject({
      userId: memberId,
      orgRole: "member",
      isOrgAdmin: false,
      teams: [{ teamId: fx.teamId, role: "member" }],
      activeTeamId: fx.teamId,
    });
    expect(me.capabilities["team.content.create"]).toEqual({ allowed: true });
    expect(me.capabilities["policies.manage"]).toEqual({
      allowed: false,
      reason: "ROLE_REQUIRED",
      requiredRole: "admin",
    });
  });
});
