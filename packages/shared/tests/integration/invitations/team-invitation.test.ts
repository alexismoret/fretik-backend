import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import db from "../../../src/db";
import { invitation, member, team, teamMember } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Inviting someone who is ALREADY in the organization to one more team.
 *
 * Better Auth refuses this outright — `/organization/invite-member` answers
 * `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` for any address it finds in
 * the `member` table, whatever `teamId` the body carries — and its accept
 * endpoint would then write a SECOND `member` row for a person who already has
 * one. Both halves are replaced by the two services under test here.
 *
 * Everything that matters about them lives in the SQL: which rows exist
 * afterwards, how many of them there are, and which `where` decided. So this
 * is an integration suite against a real Postgres, and the only double is the
 * email transport — a process boundary, and not what any assertion is about.
 */

/** Every message the services tried to send, in order. */
const sent: { to: string; subject: string }[] = [];

await mockModule("../../src/lib/email", {
  sendEmail: (options: { to: { email: string }; subject: string }) => {
    sent.push({ to: options.to.email, subject: options.subject });
    return Promise.resolve();
  },
});

const { inviteMemberToTeam } =
  await import("../../../src/services/invitations/invite-member-to-team");
const { acceptTeamInvitationForMember } =
  await import("../../../src/services/invitations/accept-team-invitation");

let fx: WorkspaceFixture;
/** The second team in the SAME organization — the grant being tested. */
let secondTeamId: string;
let secondTeamName: string;
/** The owner does the inviting; the plain member is the one invited. */
let ownerId: string;
let memberId: string;
let memberEmail: string;

const emailOf = async (userId: string): Promise<string> => {
  const row = await db.query.user.findFirst({
    columns: { email: true },
    where: { id: userId },
  });
  if (!row) throw new Error(`no user ${userId}`);
  return row.email;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  memberEmail = await emailOf(memberId);

  const created = await fx.createTeam();
  secondTeamId = created.id;
  const row = await db.query.team.findFirst({
    columns: { name: true },
    where: { id: secondTeamId },
  });
  secondTeamName = row?.name ?? "";
});

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(async () => {
  sent.length = 0;
  // Each test writes its own invitations; start from none so a status
  // assertion cannot be satisfied by a leftover from the previous test.
  await db
    .delete(invitation)
    .where(eq(invitation.organizationId, fx.organizationId));
  await db
    .delete(teamMember)
    .where(
      and(eq(teamMember.teamId, secondTeamId), eq(teamMember.userId, memberId)),
    );
  await db
    .update(team)
    .set({ memberCount: 0 })
    .where(eq(team.id, secondTeamId));
});

const pendingInvitations = () =>
  db
    .select({
      id: invitation.id,
      teamId: invitation.teamId,
      status: invitation.status,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, fx.organizationId),
        eq(invitation.email, memberEmail.toLowerCase()),
      ),
    );

describe("inviting an existing organization member to another team", () => {
  test("creates a pending invitation for that team", async () => {
    const result = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.invitation.teamId).toBe(secondTeamId);
    expect(result.invitation.status).toBe("pending");
    expect(result.invitation.email).toBe(memberEmail.toLowerCase());
  });

  test("records the role the member already holds, never a new one", async () => {
    const result = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });

    if (result.status !== "created") throw new Error("expected an invitation");
    const existing = await db.query.member.findFirst({
      columns: { role: true },
      where: { organizationId: fx.organizationId, userId: memberId },
    });
    expect(result.invitation.role).toBe(existing?.role ?? "");
  });

  test("mails the team-access copy, not the welcome-to-the-organization one", async () => {
    await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(memberEmail.toLowerCase());
    // The two subjects differ by which name they carry: the organization's for
    // a new joiner, the TEAM's for a member gaining one more workspace.
    expect(sent[0]?.subject).toContain(secondTeamName);
  });

  test("an address outside the organization is left to Better Auth", async () => {
    const result = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: `stranger-${Date.now().toString()}@example.test`,
      inviterUserId: ownerId,
    });

    expect(result.status).toBe("not-a-member");
    expect(sent).toHaveLength(0);
  });

  test("a member of the target team is refused", async () => {
    await db.insert(teamMember).values({
      teamId: secondTeamId,
      userId: memberId,
      createdAt: new Date(),
    });

    const result = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });

    expect(result).toEqual({
      status: "refused",
      reason: "USER_IS_ALREADY_A_MEMBER_OF_THIS_TEAM",
    });
  });

  test("a plain member cannot hand out team access", async () => {
    const result = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: await emailOf(ownerId),
      // The invited member is the one doing the inviting: role "member".
      inviterUserId: memberId,
    });

    expect(result).toEqual({
      status: "refused",
      reason: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
    });
    expect(sent).toHaveLength(0);
  });

  test("a team from another organization is refused", async () => {
    const other = await createWorkspaceFixture();
    try {
      const result = await inviteMemberToTeam({
        organizationId: fx.organizationId,
        teamId: other.teamId,
        email: memberEmail,
        inviterUserId: ownerId,
      });
      expect(result).toEqual({ status: "refused", reason: "TEAM_NOT_FOUND" });
    } finally {
      await other.cleanup();
    }
  });

  test("re-inviting to a team cancels only THAT team's pending invitation", async () => {
    const thirdTeam = await fx.createTeam();

    const first = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });
    const elsewhere = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: thirdTeam.id,
      email: memberEmail,
      inviterUserId: ownerId,
    });
    await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId: secondTeamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });

    if (first.status !== "created" || elsewhere.status !== "created") {
      throw new Error("expected two invitations");
    }
    const rows = await pendingInvitations();
    const byId = new Map(rows.map((r) => [r.id, r.status]));

    expect(byId.get(first.invitation.id)).toBe("canceled");
    // The other team's invitation is a different grant and survives — Better
    // Auth's org-wide sweep would have cancelled it too.
    expect(byId.get(elsewhere.invitation.id)).toBe("pending");
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });
});

describe("accepting it", () => {
  const invite = async (teamId = secondTeamId) => {
    const result = await inviteMemberToTeam({
      organizationId: fx.organizationId,
      teamId,
      email: memberEmail,
      inviterUserId: ownerId,
    });
    if (result.status !== "created") throw new Error("expected an invitation");
    return result.invitation;
  };

  test("joins the team without a second organization membership", async () => {
    const before = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, fx.organizationId),
          eq(member.userId, memberId),
        ),
      );
    expect(before).toHaveLength(1);

    const created = await invite();
    const result = await acceptTeamInvitationForMember({
      invitationId: created.id,
      userId: memberId,
      userEmail: memberEmail,
    });

    expect(result.status).toBe("accepted");

    const memberships = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, secondTeamId),
          eq(teamMember.userId, memberId),
        ),
      );
    expect(memberships).toHaveLength(1);

    // THE regression. Better Auth's own accept path ends in an unconditional
    // `createMember()`, and nothing in the schema stops it: this would be 2.
    const after = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, fx.organizationId),
          eq(member.userId, memberId),
        ),
      );
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id ?? "");
  });

  test("keeps the memberships the invitee already had", async () => {
    const created = await invite();
    await acceptTeamInvitationForMember({
      invitationId: created.id,
      userId: memberId,
      userEmail: memberEmail,
    });

    const teams = await db
      .select({ teamId: teamMember.teamId })
      .from(teamMember)
      .where(eq(teamMember.userId, memberId));
    expect(teams.map((t) => t.teamId).sort()).toEqual(
      [fx.teamId, secondTeamId].sort(),
    );
  });

  test("moves the seat counter the limit is enforced against", async () => {
    const created = await invite();
    await acceptTeamInvitationForMember({
      invitationId: created.id,
      userId: memberId,
      userEmail: memberEmail,
    });

    const seats = await db
      .select({ used: team.memberCount })
      .from(team)
      .where(eq(team.id, secondTeamId));
    const rows = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(eq(teamMember.teamId, secondTeamId));
    expect(seats[0]?.used).toBe(rows.length);
  });

  test("marks the invitation accepted, and refuses the second attempt", async () => {
    const created = await invite();
    await acceptTeamInvitationForMember({
      invitationId: created.id,
      userId: memberId,
      userEmail: memberEmail,
    });

    const row = await db.query.invitation.findFirst({
      columns: { status: true },
      where: { id: created.id },
    });
    expect(row?.status).toBe("accepted");

    const again = await acceptTeamInvitationForMember({
      invitationId: created.id,
      userId: memberId,
      userEmail: memberEmail,
    });
    expect(again).toEqual({
      status: "refused",
      reason: "INVITATION_NOT_FOUND",
    });
  });

  test("refuses a member of the same organization who is not the recipient", async () => {
    const created = await invite();

    const result = await acceptTeamInvitationForMember({
      invitationId: created.id,
      // Same organization, same everything — a different address is the ONE
      // column that may refuse here.
      userId: ownerId,
      userEmail: await emailOf(ownerId),
    });

    expect(result).toEqual({
      status: "refused",
      reason: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    });
    const joined = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, secondTeamId),
          eq(teamMember.userId, ownerId),
        ),
      );
    expect(joined).toHaveLength(0);
  });

  test("refuses an expired invitation", async () => {
    const created = await invite();
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, created.id));

    const result = await acceptTeamInvitationForMember({
      invitationId: created.id,
      userId: memberId,
      userEmail: memberEmail,
    });

    expect(result).toEqual({
      status: "refused",
      reason: "INVITATION_NOT_FOUND",
    });
  });

  test("an invitee outside the organization is left to Better Auth", async () => {
    const created = await invite();
    const outsider = await createWorkspaceFixture();
    try {
      const [outsiderId] = outsider.userIds;
      const result = await acceptTeamInvitationForMember({
        invitationId: created.id,
        userId: outsiderId,
        userEmail: memberEmail,
      });
      // No `member` row in THIS organization: the ordinary join, which the
      // plugin's own endpoint performs.
      expect(result).toEqual({ status: "not-a-member" });
    } finally {
      await outsider.cleanup();
    }
  });
});
