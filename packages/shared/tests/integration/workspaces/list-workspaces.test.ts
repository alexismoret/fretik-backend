import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  accessGrants,
  invitation,
  member,
  teamMember,
} from "../../../src/db/schema";
import { listWorkspaces } from "../../../src/services/workspaces/list-workspaces";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * Where a person can work (`services/workspaces/list-workspaces.ts`): every
 * organization they belong to, with their role and teams in each, and the
 * invitations addressed to their verified address. It is read before any
 * organization is open, so what it must never do is answer about anyone else,
 * or open an invitation to an address nobody verified.
 */

let here: WorkspaceFixture;
let there: WorkspaceFixture;
/** The person asking: the owner of `here`. */
let personId: string;
let email: string;

beforeEach(async () => {
  [here, there] = await Promise.all([
    createWorkspaceFixture(),
    createWorkspaceFixture(),
  ]);
  [personId] = here.userIds;
  const person = await db.query.user.findFirst({
    columns: { email: true },
    where: { id: personId },
  });
  if (!person) throw new Error("fixture: no person");
  email = person.email;
});

afterEach(async () => {
  await Promise.all([here.cleanup(), there.cleanup()]);
});

const workspacesOf = (emailVerified = true) =>
  listWorkspaces({ userId: personId, email, emailVerified });

const organizationName = async (id: string): Promise<string> => {
  const row = await db.query.organization.findFirst({
    columns: { name: true },
    where: { id },
  });
  return row?.name ?? "";
};

const DAY = 24 * 60 * 60 * 1000;

describe("memberships", () => {
  test("every organization the person belongs to, their role and their teams there", async () => {
    await db.insert(member).values({
      userId: personId,
      organizationId: there.organizationId,
      role: "guest",
      createdAt: new Date(),
    });
    // A second team of `here` they are in, and one they are not.
    const second = await here.createTeam();
    await here.createTeam();
    await db
      .insert(teamMember)
      .values({ userId: personId, teamId: second.id, createdAt: new Date() });

    const { memberships } = await workspacesOf();

    const expected = [
      {
        organization: here.organizationId,
        role: "owner" as const,
        teams: [here.teamId, second.id].sort(),
      },
      { organization: there.organizationId, role: "guest" as const, teams: [] },
    ];
    const names = new Map([
      [here.organizationId, await organizationName(here.organizationId)],
      [there.organizationId, await organizationName(there.organizationId)],
    ]);
    expected.sort((a, b) =>
      (names.get(a.organization) ?? "").localeCompare(
        names.get(b.organization) ?? "",
      ),
    );
    expect(
      memberships.map((m) => ({
        organization: m.organization.id,
        role: m.role,
        teams: m.teams.map((t) => t.id).sort(),
      })),
    ).toEqual(expected);
  });

  test("a guest belongs to no team, whatever a stray row says", async () => {
    await db.insert(member).values({
      userId: personId,
      organizationId: there.organizationId,
      role: "guest",
      createdAt: new Date(),
    });
    await db.insert(teamMember).values({
      userId: personId,
      teamId: there.teamId,
      createdAt: new Date(),
    });

    const { memberships } = await workspacesOf();
    expect(
      memberships.find((m) => m.organization.id === there.organizationId),
    ).toMatchObject({ role: "guest", teams: [] });
  });
});

describe("invitations", () => {
  test("the ones still waiting for this address, with what each gives", async () => {
    const [inviterThere] = there.userIds;
    const [, colleagueHere] = here.userIds;
    const second = await here.createTeam();
    const future = new Date(Date.now() + 7 * DAY);
    const rows = await db
      .insert(invitation)
      .values([
        // A guest's invitation, whatever case the address was typed in.
        {
          organizationId: there.organizationId,
          email: email.toUpperCase(),
          role: "guest",
          status: "pending",
          expiresAt: future,
          inviterId: inviterThere,
        },
        // One more team where they already belong.
        {
          organizationId: here.organizationId,
          email,
          role: "member",
          teamId: second.id,
          status: "pending",
          expiresAt: future,
          inviterId: colleagueHere,
        },
        // Past its day, withdrawn, and someone else's: none of them theirs to answer.
        {
          organizationId: there.organizationId,
          email,
          role: "member",
          status: "pending",
          expiresAt: new Date(Date.now() - DAY),
          inviterId: inviterThere,
        },
        {
          organizationId: there.organizationId,
          email,
          role: "member",
          status: "canceled",
          expiresAt: future,
          inviterId: inviterThere,
        },
        {
          organizationId: there.organizationId,
          email: `someone-${randomUUID().slice(0, 8)}@example.test`,
          role: "guest",
          status: "pending",
          expiresAt: future,
          inviterId: inviterThere,
        },
      ])
      .returning({ id: invitation.id });
    const [asGuest, toTeam] = rows;
    if (!asGuest || !toTeam) throw new Error("fixture: no invitations");
    const page = await there.createPage({ name: "Quarterly review" });
    await db.insert(accessGrants).values({
      organizationId: there.organizationId,
      resourceType: "page",
      resourceId: page.id,
      principalType: "invitation",
      principalId: asGuest.id,
      level: "view",
    });

    const { invitations } = await workspacesOf();

    expect(
      invitations
        .map((i) => ({
          id: i.id,
          organization: i.organization.id,
          role: i.role,
          team: i.team?.id ?? null,
          items: i.items.map((item) => ({
            name: item.name,
            level: item.level,
          })),
          alreadyMember: i.alreadyMember,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      [
        {
          id: asGuest.id,
          organization: there.organizationId,
          role: "guest" as const,
          team: null,
          items: [{ name: "Quarterly review", level: "view" as const }],
          alreadyMember: false,
        },
        {
          id: toTeam.id,
          organization: here.organizationId,
          role: "member" as const,
          team: second.id,
          items: [],
          alreadyMember: true,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  test("none for an address nobody verified", async () => {
    await db.insert(invitation).values({
      organizationId: there.organizationId,
      email,
      role: "guest",
      status: "pending",
      expiresAt: new Date(Date.now() + DAY),
      inviterId: there.userIds[0],
    });

    const unverified = await workspacesOf(false);
    expect(unverified.invitations).toEqual([]);
    // Where they already work is theirs either way.
    expect(unverified.memberships.map((m) => m.organization.id)).toEqual([
      here.organizationId,
    ]);
    expect((await workspacesOf(true)).invitations).toHaveLength(1);
  });
});
