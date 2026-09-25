import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  accessAuditLog,
  invitation,
  member,
  team,
  teamMember,
} from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Better Auth's organization endpoints, as Fretik leaves them.
 *
 * The ones that change who belongs where are closed, since our routes replace
 * them (`lib/auth-replaced-endpoints.ts`). The ones the app still calls stay
 * open, and what runs in front of them is the subject here
 * (`lib/auth-hooks.ts`): accepting a team invitation as someone ALREADY in the
 * organization, and every neighbouring case that must keep working. The
 * invitations are made through the app's own door (`inviteToTeam`).
 *
 * The hooks only exist as a SEAM, a `hooks.before` in front of the plugin's
 * endpoints. Testing their conditions apart from the dispatch would prove
 * nothing: a wrong `ctx.path`, or a return value Better Auth reads as a
 * `{ context }` patch rather than a response, and the plugin's own handler
 * runs exactly as it did before, with a green suite either way.
 *
 * So every endpoint here goes through `auth.api.*`, the same dispatch the HTTP
 * router uses (`toAuthEndpoints` → `dispatchAuthEndpoint` → hooks → endpoint).
 * Real sessions, real cookies, real rows; the only double is the email
 * transport, which no assertion is about beyond WHICH message was sent.
 */

/** Every message the hook tried to send, in order. */
const sent: { to: string; subject: string }[] = [];

await mockModule("../../src/lib/email", {
  sendEmail: (options: { to: { email: string }; subject: string }) => {
    sent.push({ to: options.to.email, subject: options.subject });
    return Promise.resolve();
  },
});

const { auth } = await import("../../../src/lib/auth");
const { SIGNUP_INVITATION_HEADER } =
  await import("../../../src/services/auth/signup-gate");
const { inviteToTeam } =
  await import("../../../src/services/invitations/invite-to-team");
const { removeTeamMember } =
  await import("../../../src/services/team/remove-member");

const PASSWORD = "integration-password-1";

interface Account {
  userId: string;
  email: string;
  headers: Headers;
}

/** `set-cookie` lines folded into the `cookie` header a next call must send. */
const cookieHeader = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");

/**
 * An account with a usable password, made a member of `workspace` at `role`
 * and added to its first team.
 *
 * Sign-up is gated (closed beta) and, with `requireEmailVerification`, an
 * unverified account cannot sign in — so this borrows the product's own
 * mechanism: a pending invitation, presented by id the way the invitation page
 * sends it, both opens the gate and auto-verifies the account
 * (`databaseHooks.user.create.before`). It is cancelled straight after so no
 * assertion below can see it.
 */
const createAccount = async (
  workspace: WorkspaceFixture,
  role: string,
): Promise<Account> => {
  const email = `it-auth-${randomUUID().slice(0, 8)}@example.test`;

  const [bootstrap] = await db
    .insert(invitation)
    .values({
      organizationId: workspace.organizationId,
      email,
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: workspace.userIds[0],
    })
    .returning({ id: invitation.id });
  if (!bootstrap) throw new Error("fixture: failed to seed the signup gate");

  const signUp = await auth.api.signUpEmail({
    body: { name: "Integration user", email, password: PASSWORD },
    headers: presenting(bootstrap.id),
  });

  await db
    .update(invitation)
    .set({ status: "canceled" })
    .where(eq(invitation.id, bootstrap.id));

  await db.insert(member).values({
    organizationId: workspace.organizationId,
    userId: signUp.user.id,
    role,
    createdAt: new Date(),
  });
  await db.insert(teamMember).values({
    teamId: workspace.teamId,
    userId: signUp.user.id,
    createdAt: new Date(),
  });

  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const headers = new Headers({ cookie: cookieHeader(signIn.headers) });

  // The endpoints read the ACTIVE organization from the session (the UI
  // never sends an organizationId), so set it the way the app does.
  await auth.api.setActiveOrganization({
    body: { organizationId: workspace.organizationId },
    headers,
  });

  return { userId: signUp.user.id, email, headers };
};

/** The headers of a sign-up made from an invitation's link. */
const presenting = (invitationId: string): Headers =>
  new Headers({ [SIGNUP_INVITATION_HEADER]: invitationId });

/** The `{ message, code }` an endpoint refused with, or null if it succeeded. */
const refusalOf = async (call: Promise<unknown>): Promise<string | null> =>
  call.then(
    () => null,
    (error: unknown) => JSON.stringify(error),
  );

const teamsOf = async (userId: string): Promise<string[]> => {
  const rows = await db
    .select({ teamId: teamMember.teamId })
    .from(teamMember)
    .where(eq(teamMember.userId, userId));
  return rows.map((r) => r.teamId).sort();
};

const organizationsOf = async (userId: string): Promise<string[]> => {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  return rows.map((r) => r.organizationId).sort();
};

const membershipsIn = async (
  organizationId: string,
  userId: string,
): Promise<string[]> => {
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    );
  return rows.map((r) => r.id);
};

let fx: WorkspaceFixture;
/** A second team in the SAME organization — the grant under test. */
let secondTeamId: string;
let secondTeamName: string;
let owner: Account;
/** Already in the organization, and in the first team only. */
let existing: Account;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  secondTeamId = (await fx.createTeam()).id;
  secondTeamName =
    (
      await db.query.team.findFirst({
        columns: { name: true },
        where: { id: secondTeamId },
      })
    )?.name ?? "";
  owner = await createAccount(fx, "owner");
  existing = await createAccount(fx, "member");
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * Bun shuffles test order (it prints the `--seed` it used), so no test may
 * inherit the membership or the invitation another one left behind.
 */
beforeEach(async () => {
  sent.length = 0;
  // Through the service, not a raw DELETE: `team.member_count` is a durable
  // counter the seat limit is enforced against, and a test that unpicks a
  // membership behind its back leaves the table and the counter disagreeing,
  // which is exactly what the seat assertion below reads. Refuses (404) when
  // there is nothing to undo, which is the usual case here.
  await removeTeamMember({
    principal: await fx.principalOf(owner.userId),
    teamId: secondTeamId,
    userId: existing.userId,
  }).catch(() => undefined);
  await db
    .delete(invitation)
    .where(
      and(
        eq(invitation.organizationId, fx.organizationId),
        eq(invitation.email, existing.email.toLowerCase()),
      ),
    );
});

/** Invite someone to a team through the app's own door; the invitation's id. */
const invite = async (
  email: string,
  teamId = secondTeamId,
): Promise<string> => {
  const [outcome] = await inviteToTeam({
    principal: await fx.principalOf(owner.userId),
    teamId,
    invitations: [{ email, role: "member" }],
  });
  if (!outcome?.invitationId) throw new Error("fixture: not invited");
  return outcome.invitationId;
};

const invitationRow = async (id: string) =>
  db.query.invitation.findFirst({
    columns: { role: true, status: true, teamId: true },
    where: { id },
  });

describe("the endpoints our routes replace", () => {
  test("are closed, to an owner too, and change nothing", async () => {
    const [memberId] = await membershipsIn(fx.organizationId, existing.userId);
    if (!memberId) throw new Error("fixture: no membership");
    const waiting = await invite(
      `it-waiting-${randomUUID().slice(0, 8)}@example.test`,
    );
    const sideDoor = `side-door-${randomUUID().slice(0, 8)}`;
    const asOwner = { headers: owner.headers };

    const refusals = await Promise.all([
      refusalOf(
        auth.api.createInvitation({
          ...asOwner,
          body: {
            email: `it-closed-${randomUUID().slice(0, 8)}@example.test`,
            role: "member",
            teamId: secondTeamId,
          },
        }),
      ),
      refusalOf(
        auth.api.cancelInvitation({
          ...asOwner,
          body: { invitationId: waiting },
        }),
      ),
      refusalOf(
        auth.api.updateMemberRole({
          ...asOwner,
          body: { memberId, role: "admin" },
        }),
      ),
      refusalOf(
        auth.api.removeMember({
          ...asOwner,
          body: { memberIdOrEmail: existing.email },
        }),
      ),
      refusalOf(auth.api.createTeam({ ...asOwner, body: { name: sideDoor } })),
      refusalOf(
        auth.api.updateTeam({
          ...asOwner,
          body: { teamId: secondTeamId, data: { name: sideDoor } },
        }),
      ),
      refusalOf(
        auth.api.addTeamMember({
          ...asOwner,
          body: { teamId: secondTeamId, userId: existing.userId },
        }),
      ),
      refusalOf(
        auth.api.removeTeamMember({
          ...asOwner,
          body: { teamId: fx.teamId, userId: existing.userId },
        }),
      ),
    ]);
    for (const refusal of refusals)
      expect(refusal).toContain("ENDPOINT_REPLACED");

    // Nothing moved: the same membership at the same role, in the same team,
    // the invitation still waiting, and no team named through the side door.
    const membership = await db.query.member.findFirst({
      columns: { role: true },
      where: { id: memberId },
    });
    expect(membership?.role).toBe("member");
    expect(await teamsOf(existing.userId)).toEqual([fx.teamId]);
    expect((await invitationRow(waiting))?.status).toBe("pending");
    const named = await db
      .select({ id: team.id })
      .from(team)
      .where(
        and(
          eq(team.organizationId, fx.organizationId),
          eq(team.name, sideDoor),
        ),
      );
    expect(named).toEqual([]);
  });
});

describe("inviting someone of the organization to one more team", () => {
  test("keeps the role they hold, whatever was asked", async () => {
    const [outcome] = await inviteToTeam({
      principal: await fx.principalOf(owner.userId),
      teamId: secondTeamId,
      invitations: [{ email: existing.email, role: "admin" }],
    });

    // A team invitation is not a role change, and the pending list must not
    // promise one the accept path will not keep.
    expect(await invitationRow(outcome?.invitationId ?? "")).toEqual({
      role: "member",
      status: "pending",
      teamId: secondTeamId,
    });
  });

  test("mails the team-access copy, not the welcome-to-the-organization one", async () => {
    await invite(existing.email);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(existing.email.toLowerCase());
    // The two subjects differ by which name they carry: the organization's for
    // a new joiner, the TEAM's for a member gaining one more workspace.
    expect(sent[0]?.subject).toContain(secondTeamName);
  });

  test("re-inviting to a team cancels only THAT team's pending invitation", async () => {
    const thirdTeamId = (await fx.createTeam()).id;

    const first = await invite(existing.email);
    const elsewhere = await invite(existing.email, thirdTeamId);
    await invite(existing.email);

    const rows = await db
      .select({ id: invitation.id, status: invitation.status })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, fx.organizationId),
          eq(invitation.email, existing.email.toLowerCase()),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r.status]));

    expect(byId.get(first)).toBe("canceled");
    // The other team's invitation is a different grant and survives.
    expect(byId.get(elsewhere)).toBe("pending");
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  test("someone outside it, with an account elsewhere or none, is welcomed into it", async () => {
    const other = await createWorkspaceFixture();
    try {
      const outsider = await createAccount(other, "member");
      const stranger = `it-new-${randomUUID().slice(0, 8)}@example.test`;
      // Their sign-up sent an OTP through the same transport.
      sent.length = 0;

      // Membership is per organization: neither is in this one, so each is
      // invited into it, with the welcome copy rather than the team-access one.
      const waiting = { status: "pending", teamId: secondTeamId };
      expect(await invitationRow(await invite(outsider.email))).toMatchObject(
        waiting,
      );
      expect(await invitationRow(await invite(stranger))).toMatchObject(
        waiting,
      );
      expect(sent).toHaveLength(2);
      for (const message of sent) {
        expect(message.subject).not.toContain(secondTeamName);
      }
    } finally {
      await other.cleanup();
    }
  });
});

describe("the invariant behind all of this", () => {
  test("the database refuses a second membership in one organization", async () => {
    // The hook is what keeps `createMember()` off an existing member, and it
    // is code — this is the constraint that makes the bad state unreachable
    // whatever the code does. Drop `member_organizationId_userId_uidx` and
    // this insert succeeds.
    const duplicate = db.insert(member).values({
      organizationId: fx.organizationId,
      userId: existing.userId,
      role: "admin",
      createdAt: new Date(),
    });

    // Drizzle wraps the driver error, and the constraint name lives on the
    // cause — assert on THAT, so a failure for any other reason cannot pass
    // for the one this test is about.
    const constraint = await duplicate.then(
      () => null,
      (e: unknown) =>
        e instanceof Error && e.cause instanceof Error
          ? e.cause.message
          : String(e),
    );
    expect(constraint).toContain("member_organizationId_userId_uidx");
    expect(
      await membershipsIn(fx.organizationId, existing.userId),
    ).toHaveLength(1);
  });
});

describe("POST /organization/accept-invitation", () => {
  const inviteExisting = async () => invite(existing.email);

  test("joins the team and leaves the organization membership alone", async () => {
    const before = await membershipsIn(fx.organizationId, existing.userId);
    expect(before).toHaveLength(1);

    const created = await inviteExisting();
    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: created },
      headers: existing.headers,
    });
    expect(accepted?.invitation.status).toBe("accepted");

    // THE regression. The plugin's own accept ends in an unconditional
    // `createMember()`, and before the unique index nothing in the schema
    // stopped it: this would be 2.
    const after = await membershipsIn(fx.organizationId, existing.userId);
    expect(after).toEqual(before);

    // The team they already had is still theirs, and the new one is added.
    expect(await teamsOf(existing.userId)).toEqual(
      [fx.teamId, secondTeamId].sort(),
    );
    // The journal says who joined which team, by the names of the day.
    const [entry] = await db
      .select({
        actorUserId: accessAuditLog.actorUserId,
        metadata: accessAuditLog.metadata,
      })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.action, "invitation.accepted"),
          eq(accessAuditLog.principalId, created),
        ),
      );
    expect(entry).toMatchObject({
      actorUserId: existing.userId,
      metadata: {
        email: existing.email.toLowerCase(),
        teamId: secondTeamId,
        teamName: secondTeamName,
      },
    });
  });

  test("moves the seat counter the limit is enforced against", async () => {
    const created = await inviteExisting();
    await auth.api.acceptInvitation({
      body: { invitationId: created },
      headers: existing.headers,
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

  test("refuses the second attempt on the same invitation", async () => {
    const created = await inviteExisting();
    await auth.api.acceptInvitation({
      body: { invitationId: created },
      headers: existing.headers,
    });

    const refusal = await refusalOf(
      auth.api.acceptInvitation({
        body: { invitationId: created },
        headers: existing.headers,
      }),
    );
    expect(refusal).toContain("INVITATION_NOT_FOUND");
  });

  test("refuses a member of the same organization who is not the recipient", async () => {
    const created = await inviteExisting();

    const refusal = await refusalOf(
      auth.api.acceptInvitation({
        body: { invitationId: created },
        // Same organization, same everything — a different address is the ONE
        // column that may refuse here.
        headers: owner.headers,
      }),
    );

    expect(refusal).toContain("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION");
    expect(await teamsOf(owner.userId)).not.toContain(secondTeamId);
  });

  test("refuses an expired invitation", async () => {
    const created = await inviteExisting();
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, created));

    const refusal = await refusalOf(
      auth.api.acceptInvitation({
        body: { invitationId: created },
        headers: existing.headers,
      }),
    );
    expect(refusal).toContain("INVITATION_NOT_FOUND");
  });

  test("a brand-new account joins through Better Auth", async () => {
    const newcomer = `it-join-${randomUUID().slice(0, 8)}@example.test`;
    const created = await invite(newcomer);

    const signUp = await auth.api.signUpEmail({
      body: { name: "Newcomer", email: newcomer, password: PASSWORD },
      headers: presenting(created),
    });
    const signIn = await auth.api.signInEmail({
      body: { email: newcomer, password: PASSWORD },
      returnHeaders: true,
    });

    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: created },
      headers: new Headers({ cookie: cookieHeader(signIn.headers) }),
    });
    expect(accepted?.invitation.status).toBe("accepted");

    // The path we did NOT take: the plugin creates the organization membership
    // a first-time joiner needs.
    expect(await membershipsIn(fx.organizationId, signUp.user.id)).toHaveLength(
      1,
    );
    expect(await teamsOf(signUp.user.id)).toEqual([secondTeamId]);
  });

  test("an account from another organization ends up in BOTH", async () => {
    const other = await createWorkspaceFixture();
    try {
      const outsider = await createAccount(other, "member");

      const created = await invite(outsider.email);
      const accepted = await auth.api.acceptInvitation({
        body: { invitationId: created },
        headers: outsider.headers,
      });
      expect(accepted?.invitation.status).toBe("accepted");

      // Two organizations, one membership in each — not a second row in
      // either, and nothing taken away from the one they arrived with.
      expect(await organizationsOf(outsider.userId)).toEqual(
        [fx.organizationId, other.organizationId].sort(),
      );
      expect(
        await membershipsIn(other.organizationId, outsider.userId),
      ).toHaveLength(1);
      expect(
        await membershipsIn(fx.organizationId, outsider.userId),
      ).toHaveLength(1);

      // And a team in each, so the switcher can move between them.
      expect(await teamsOf(outsider.userId)).toEqual(
        [other.teamId, secondTeamId].sort(),
      );
    } finally {
      await other.cleanup();
    }
  });
});

/**
 * An invitation EXISTING for an address says nothing about who is typing it.
 * Auto-verifying on that alone let anyone register an invited address before
 * its owner did, sign straight in, and accept the invitation as them. Only the
 * invitation's id — what the emailed link carries — proves the inbox.
 */
describe("sign-up of an invited address", () => {
  const seedInvitation = async (email: string): Promise<string> => {
    const [row] = await db
      .insert(invitation)
      .values({
        organizationId: fx.organizationId,
        email,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: fx.userIds[0],
      })
      .returning({ id: invitation.id });
    if (!row) throw new Error("fixture: no invitation");
    return row.id;
  };

  const isVerified = async (userId: string): Promise<boolean | undefined> =>
    (
      await db.query.user.findFirst({
        columns: { emailVerified: true },
        where: { id: userId },
      })
    )?.emailVerified;

  test("without the invitation's id, the account must verify its email", async () => {
    const email = `it-squat-${randomUUID().slice(0, 8)}@example.test`;
    await seedInvitation(email);

    const signUp = await auth.api.signUpEmail({
      body: { name: "Not the invitee", email, password: PASSWORD },
    });

    expect(await isVerified(signUp.user.id)).toBe(false);
    expect(
      await refusalOf(
        auth.api.signInEmail({ body: { email, password: PASSWORD } }),
      ),
    ).toContain("EMAIL_NOT_VERIFIED");
  });

  test("with the id of ANOTHER invitation, it is not verified either", async () => {
    const email = `it-mixed-${randomUUID().slice(0, 8)}@example.test`;
    await seedInvitation(email);
    const someoneElses = await seedInvitation(
      `it-other-${randomUUID().slice(0, 8)}@example.test`,
    );

    const signUp = await auth.api.signUpEmail({
      body: { name: "Wrong link", email, password: PASSWORD },
      headers: presenting(someoneElses),
    });

    expect(await isVerified(signUp.user.id)).toBe(false);
  });

  test("with its own invitation's id, the account is verified", async () => {
    const email = `it-invitee-${randomUUID().slice(0, 8)}@example.test`;
    const invitationId = await seedInvitation(email);

    const signUp = await auth.api.signUpEmail({
      body: { name: "The invitee", email, password: PASSWORD },
      headers: presenting(invitationId),
    });

    expect(await isVerified(signUp.user.id)).toBe(true);
  });
});

describe("POST /organization/leave", () => {
  test("is journaled as a departure, by the person leaving", async () => {
    const leaving = await createAccount(fx, "member");

    await auth.api.leaveOrganization({
      body: { organizationId: fx.organizationId },
      headers: leaving.headers,
    });

    expect(await membershipsIn(fx.organizationId, leaving.userId)).toEqual([]);
    const journal = await db
      .select({
        actorUserId: accessAuditLog.actorUserId,
        metadata: accessAuditLog.metadata,
      })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "member.removed"),
          eq(accessAuditLog.principalId, leaving.userId),
        ),
      );
    expect(journal).toEqual([
      {
        actorUserId: leaving.userId,
        metadata: {
          userName: "Integration user",
          email: leaving.email,
          role: "member",
          left: true,
        },
      },
    ]);
  });
});

describe("POST /organization/remove-team", () => {
  test("withdraws the invitations into that team alone, and journals them", async () => {
    const doomed = await fx.createTeam();
    const pending = (teamId: string) => ({
      organizationId: fx.organizationId,
      email: `it-doomed-${randomUUID().slice(0, 8)}@example.test`,
      role: "member",
      teamId,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: owner.userId,
    });
    const [into, elsewhere] = await db
      .insert(invitation)
      .values([pending(doomed.id), pending(fx.teamId)])
      .returning({ id: invitation.id });
    if (!into || !elsewhere) throw new Error("fixture: no invitations");

    await auth.api.removeTeam({
      body: { teamId: doomed.id, organizationId: fx.organizationId },
      headers: owner.headers,
    });

    const rows = await db
      .select({
        id: invitation.id,
        status: invitation.status,
        teamId: invitation.teamId,
      })
      .from(invitation)
      .where(inArray(invitation.id, [into.id, elsewhere.id]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Not left pending with no team, as Better Auth alone would leave it.
    expect(byId.get(into.id)?.status).toBe("canceled");
    expect(byId.get(elsewhere.id)).toMatchObject({
      status: "pending",
      teamId: fx.teamId,
    });
    const journal = await db
      .select({ principalId: accessAuditLog.principalId })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "invitation.canceled"),
          eq(accessAuditLog.principalId, into.id),
        ),
      );
    expect(journal).toHaveLength(1);
  });
});
