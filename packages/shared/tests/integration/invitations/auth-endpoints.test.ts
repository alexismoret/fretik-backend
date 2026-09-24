import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { invitation, member, team, teamMember } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Inviting someone who is ALREADY in the organization to one more team, and
 * every neighbouring case that must keep working.
 *
 * The subject is `lib/auth-hooks.ts`, and it only exists as a SEAM: a
 * `hooks.before` that takes two organization endpoints away from Better Auth
 * under precise conditions and hands every other invitation back. Testing the
 * conditions apart from the dispatch would prove nothing — a wrong `ctx.path`,
 * or a return value Better Auth reads as a `{ context }` patch rather than a
 * response, and the plugin's own guard answers
 * `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` exactly as it did before,
 * with a green suite either way.
 *
 * So everything here goes through `auth.api.*`, the same dispatch the HTTP
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

  // The invite path reads the ACTIVE organization from the session — the UI
  // never sends an organizationId — so set it the way the app does.
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
  // Through the endpoint, not a raw DELETE: `team.member_count` is a durable
  // counter the seat limit is enforced against, and a test that unpicks a
  // membership behind its back leaves the table and the counter disagreeing —
  // which is exactly what the seat assertion below reads.
  // Refuses with USER_IS_NOT_A_MEMBER_OF_THE_TEAM when there is nothing to
  // undo, which is the usual case here.
  await auth.api
    .removeTeamMember({
      body: { teamId: secondTeamId, userId: existing.userId },
      headers: owner.headers,
    })
    .catch(() => undefined);
  await db
    .delete(invitation)
    .where(
      and(
        eq(invitation.organizationId, fx.organizationId),
        eq(invitation.email, existing.email.toLowerCase()),
      ),
    );
});

describe("POST /organization/invite-member", () => {
  test("invites an existing organization member to another team", async () => {
    // Before the hook existed this threw
    // USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION — the reported bug.
    const created = await auth.api.createInvitation({
      body: { email: existing.email, role: "admin", teamId: secondTeamId },
      headers: owner.headers,
    });

    expect(created.teamId).toBe(secondTeamId);
    expect(created.status).toBe("pending");
    expect(created.email).toBe(existing.email.toLowerCase());
    // The role they ALREADY hold, not the "admin" that was asked for: a team
    // invitation is not a role change, and the pending list must not promise
    // one the accept path will not keep.
    expect(created.role).toBe("member");
  });

  test("mails the team-access copy, not the welcome-to-the-organization one", async () => {
    await auth.api.createInvitation({
      body: { email: existing.email, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(existing.email.toLowerCase());
    // The two subjects differ by which name they carry: the organization's for
    // a new joiner, the TEAM's for a member gaining one more workspace.
    expect(sent[0]?.subject).toContain(secondTeamName);
  });

  test("still refuses an existing member with no team named", async () => {
    // No `teamId` means "join the organization", which they already did. The
    // hook must not touch this: Better Auth's refusal is the right answer.
    const refusal = await refusalOf(
      auth.api.createInvitation({
        body: { email: existing.email, role: "member" },
        headers: owner.headers,
      }),
    );

    expect(refusal).toContain("USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION");
  });

  test("refuses a member of the target team", async () => {
    await auth.api.addTeamMember({
      body: { teamId: secondTeamId, userId: existing.userId },
      headers: owner.headers,
    });

    const refusal = await refusalOf(
      auth.api.createInvitation({
        body: { email: existing.email, role: "member", teamId: secondTeamId },
        headers: owner.headers,
      }),
    );

    expect(refusal).toContain("USER_IS_ALREADY_A_MEMBER_OF_THIS_TEAM");
    expect(sent).toHaveLength(0);
  });

  test("refuses a plain member handing out team access", async () => {
    const refusal = await refusalOf(
      auth.api.createInvitation({
        body: { email: owner.email, role: "member", teamId: secondTeamId },
        headers: existing.headers,
      }),
    );

    expect(refusal).toContain(
      "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
    );
    expect(sent).toHaveLength(0);
  });

  test("refuses a team belonging to another organization", async () => {
    const other = await createWorkspaceFixture();
    try {
      const refusal = await refusalOf(
        auth.api.createInvitation({
          body: {
            email: existing.email,
            role: "member",
            teamId: other.teamId,
          },
          headers: owner.headers,
        }),
      );
      expect(refusal).toContain("TEAM_NOT_FOUND");
    } finally {
      await other.cleanup();
    }
  });

  test("re-inviting to a team cancels only THAT team's pending invitation", async () => {
    const thirdTeamId = (await fx.createTeam()).id;

    const first = await auth.api.createInvitation({
      body: { email: existing.email, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });
    const elsewhere = await auth.api.createInvitation({
      body: { email: existing.email, role: "member", teamId: thirdTeamId },
      headers: owner.headers,
    });
    await auth.api.createInvitation({
      body: { email: existing.email, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

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

    expect(byId.get(first.id)).toBe("canceled");
    // The other team's invitation is a different grant and survives — Better
    // Auth's org-wide sweep would have cancelled it too.
    expect(byId.get(elsewhere.id)).toBe("pending");
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  test("an address with no account takes Better Auth's path", async () => {
    const stranger = `it-new-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.createInvitation({
      body: { email: stranger, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    expect(created.email).toBe(stranger);
    expect(created.teamId).toBe(secondTeamId);
    expect(created.status).toBe("pending");
  });

  test("an account in ANOTHER organization takes Better Auth's path", async () => {
    const other = await createWorkspaceFixture();
    try {
      const outsider = await createAccount(other, "member");
      // Their sign-up sent an OTP through the same transport.
      sent.length = 0;

      // Membership is per organization: they are not in this one, so this is
      // an ordinary organization invitation and the hook must stand aside.
      const created = await auth.api.createInvitation({
        body: {
          email: outsider.email,
          role: "member",
          teamId: secondTeamId,
        },
        headers: owner.headers,
      });

      expect(created.email).toBe(outsider.email.toLowerCase());
      expect(created.teamId).toBe(secondTeamId);
      expect(created.status).toBe("pending");
      // ...and it is the welcome copy, not the team-access one.
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).not.toContain(secondTeamName);
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
  const inviteExisting = async (teamId = secondTeamId) =>
    auth.api.createInvitation({
      body: { email: existing.email, role: "member", teamId },
      headers: owner.headers,
    });

  test("joins the team and leaves the organization membership alone", async () => {
    const before = await membershipsIn(fx.organizationId, existing.userId);
    expect(before).toHaveLength(1);

    const created = await inviteExisting();
    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: created.id },
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
  });

  test("moves the seat counter the limit is enforced against", async () => {
    const created = await inviteExisting();
    await auth.api.acceptInvitation({
      body: { invitationId: created.id },
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
      body: { invitationId: created.id },
      headers: existing.headers,
    });

    const refusal = await refusalOf(
      auth.api.acceptInvitation({
        body: { invitationId: created.id },
        headers: existing.headers,
      }),
    );
    expect(refusal).toContain("INVITATION_NOT_FOUND");
  });

  test("refuses a member of the same organization who is not the recipient", async () => {
    const created = await inviteExisting();

    const refusal = await refusalOf(
      auth.api.acceptInvitation({
        body: { invitationId: created.id },
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
      .where(eq(invitation.id, created.id));

    const refusal = await refusalOf(
      auth.api.acceptInvitation({
        body: { invitationId: created.id },
        headers: existing.headers,
      }),
    );
    expect(refusal).toContain("INVITATION_NOT_FOUND");
  });

  test("a brand-new account joins through Better Auth", async () => {
    const newcomer = `it-join-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.createInvitation({
      body: { email: newcomer, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    const signUp = await auth.api.signUpEmail({
      body: { name: "Newcomer", email: newcomer, password: PASSWORD },
      headers: presenting(created.id),
    });
    const signIn = await auth.api.signInEmail({
      body: { email: newcomer, password: PASSWORD },
      returnHeaders: true,
    });

    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: created.id },
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

      const created = await auth.api.createInvitation({
        body: { email: outsider.email, role: "member", teamId: secondTeamId },
        headers: owner.headers,
      });
      const accepted = await auth.api.acceptInvitation({
        body: { invitationId: created.id },
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
  const invite = async (email: string): Promise<string> => {
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
    await invite(email);

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
    await invite(email);
    const someoneElses = await invite(
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
    const invitationId = await invite(email);

    const signUp = await auth.api.signUpEmail({
      body: { name: "The invitee", email, password: PASSWORD },
      headers: presenting(invitationId),
    });

    expect(await isVerified(signUp.user.id)).toBe(true);
  });
});
