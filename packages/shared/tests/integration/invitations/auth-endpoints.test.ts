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
import { invitation, member, teamMember } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * The SEAM, not the services: does `hooks.before` actually take the two
 * organization endpoints away from Better Auth, and — just as important — does
 * it leave every other invitation alone?
 *
 * `team-invitation.test.ts` proves what the services write. That proof is worth
 * nothing if the hook never fires, or fires on the wrong request: a wrong
 * `ctx.path`, a return value Better Auth reads as a `{ context }` patch instead
 * of a response, and the plugin's own guard answers
 * `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` exactly as it did before —
 * with every service test still green.
 *
 * So this suite goes through `auth.api.*`, which is the same dispatch the HTTP
 * router uses (`toAuthEndpoints` → `dispatchAuthEndpoint` → hooks → endpoint).
 * Real sessions, real cookies, real rows. The only double is the email
 * transport.
 */

await mockModule("../../src/lib/email", {
  sendEmail: () => Promise.resolve(),
});

const { auth } = await import("../../../src/lib/auth");

let fx: WorkspaceFixture;
let secondTeamId: string;

const PASSWORD = "integration-password-1";

/** `set-cookie` lines folded into the `cookie` header a next call must send. */
const cookieHeader = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");

/**
 * An account with a usable password, made a member of the fixture's
 * organization at `role`.
 *
 * Sign-up is gated (closed beta) and, with `requireEmailVerification`, an
 * unverified account cannot sign in — so this borrows the product's own
 * mechanism: a pending invitation both opens the gate and auto-verifies the
 * account (`databaseHooks.user.create.before`). The invitation is cancelled
 * straight after so no assertion below can see it.
 */
const createSignedInUser = async (
  role: string,
): Promise<{ userId: string; email: string; headers: Headers }> => {
  const email = `it-auth-${randomUUID().slice(0, 8)}@example.test`;

  const [bootstrap] = await db
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
  if (!bootstrap) throw new Error("fixture: failed to seed the signup gate");

  const signUp = await auth.api.signUpEmail({
    body: { name: "Integration user", email, password: PASSWORD },
  });

  await db
    .update(invitation)
    .set({ status: "canceled" })
    .where(eq(invitation.id, bootstrap.id));

  await db.insert(member).values({
    organizationId: fx.organizationId,
    userId: signUp.user.id,
    role,
    createdAt: new Date(),
  });
  await db.insert(teamMember).values({
    teamId: fx.teamId,
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
    body: { organizationId: fx.organizationId },
    headers,
  });

  return { userId: signUp.user.id, email, headers };
};

let owner: { userId: string; email: string; headers: Headers };
let existing: { userId: string; email: string; headers: Headers };

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  secondTeamId = (await fx.createTeam()).id;
  owner = await createSignedInUser("owner");
  existing = await createSignedInUser("member");
});

afterAll(async () => {
  await fx.cleanup();
});

/**
 * Bun shuffles test order (it prints the `--seed` it used), so no test may
 * inherit the membership or the invitation another one left behind: put the
 * invited member back outside the second team before each.
 */
beforeEach(async () => {
  await db
    .delete(teamMember)
    .where(
      and(
        eq(teamMember.teamId, secondTeamId),
        eq(teamMember.userId, existing.userId),
      ),
    );
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
      body: { email: existing.email, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    expect(created.teamId).toBe(secondTeamId);
    expect(created.status).toBe("pending");
    expect(created.email).toBe(existing.email.toLowerCase());
  });

  test("still refuses an existing member with no team named", async () => {
    // No `teamId` means "join the organization", which they already did. The
    // hook must not touch this: Better Auth's refusal is the right answer.
    const refusal = await auth.api
      .createInvitation({
        body: { email: existing.email, role: "member" },
        headers: owner.headers,
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refusal).not.toBeNull();
    expect(JSON.stringify(refusal)).toContain(
      "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
    );
  });

  test("an address with no account still takes Better Auth's path", async () => {
    const stranger = `it-new-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.createInvitation({
      body: { email: stranger, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    expect(created.email).toBe(stranger);
    expect(created.teamId).toBe(secondTeamId);
    expect(created.status).toBe("pending");
  });
});

describe("POST /organization/accept-invitation", () => {
  test("joins the team and leaves the organization membership alone", async () => {
    const created = await auth.api.createInvitation({
      body: { email: existing.email, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: created.id },
      headers: existing.headers,
    });
    expect(accepted?.invitation.status).toBe("accepted");

    const joined = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, secondTeamId),
          eq(teamMember.userId, existing.userId),
        ),
      );
    expect(joined).toHaveLength(1);

    // The plugin's own accept ends in an unconditional `createMember()`; this
    // is the assertion that catches it coming back.
    const memberships = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, fx.organizationId),
          eq(member.userId, existing.userId),
        ),
      );
    expect(memberships).toHaveLength(1);
  });

  test("a brand-new account still joins through Better Auth", async () => {
    const newcomer = `it-join-${randomUUID().slice(0, 8)}@example.test`;
    const created = await auth.api.createInvitation({
      body: { email: newcomer, role: "member", teamId: secondTeamId },
      headers: owner.headers,
    });

    const signUp = await auth.api.signUpEmail({
      body: { name: "Newcomer", email: newcomer, password: PASSWORD },
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

    // The path we did NOT take: Better Auth creates the organization
    // membership a first-time joiner needs.
    const memberships = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, fx.organizationId),
          eq(member.userId, signUp.user.id),
        ),
      );
    expect(memberships).toHaveLength(1);

    const joined = await db
      .select({ id: teamMember.id })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, secondTeamId),
          eq(teamMember.userId, signUp.user.id),
        ),
      );
    expect(joined).toHaveLength(1);
  });
});
