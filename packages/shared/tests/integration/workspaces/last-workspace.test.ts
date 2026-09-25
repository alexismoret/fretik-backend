import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  invitation,
  lastWorkspaces,
  member,
  teamMember,
  user,
} from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Where each person last worked, and the session that opens there
 * (`services/workspaces/last-workspace.ts`, wired to Better Auth's sessions in
 * `lib/auth-workspace.ts`).
 *
 * The service is checked on its own for what it reopens against today's
 * memberships. The wiring is checked through `auth.api.*`, the dispatch the
 * HTTP router uses: a hook on the wrong model or the wrong moment would leave
 * every service test green and no session ever reopening anything.
 */

// Nothing here is about email; a departure's own steps reach the transport.
await mockModule("../../src/lib/email", {
  sendEmail: () => Promise.resolve(),
});

const { auth } = await import("../../../src/lib/auth");
const { onMemberLeftOrganization } =
  await import("../../../src/lib/auth-membership");
const { SIGNUP_INVITATION_HEADER } =
  await import("../../../src/services/auth/signup-gate");
const { rememberWorkspace, workspaceToReopen } =
  await import("../../../src/services/workspaces/last-workspace");

let fx: WorkspaceFixture;
/** Accounts made through Better Auth, which the fixture's cleanup does not know. */
const accounts: string[] = [];

beforeEach(async () => {
  fx = await createWorkspaceFixture();
});

afterEach(async () => {
  await fx.cleanup();
  if (accounts.length > 0) {
    await db.delete(user).where(inArray(user.id, accounts.splice(0)));
  }
});

const lastOf = async (userId: string) =>
  (
    await db
      .select({
        organizationId: lastWorkspaces.organizationId,
        teamId: lastWorkspaces.teamId,
        updatedAt: lastWorkspaces.updatedAt,
      })
      .from(lastWorkspaces)
      .where(eq(lastWorkspaces.userId, userId))
  )[0] ?? null;

const leaveTeam = async (userId: string, teamId: string) => {
  await db
    .delete(teamMember)
    .where(and(eq(teamMember.userId, userId), eq(teamMember.teamId, teamId)));
};

describe("the last workspace", () => {
  test("is written when the place changes, and only then", async () => {
    const [personId] = fx.userIds;
    const second = await fx.createTeam();

    await rememberWorkspace({
      userId: personId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });
    const first = await lastOf(personId);
    expect(first).toMatchObject({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });

    // The same place again, as a session's sliding expiry writes it.
    await rememberWorkspace({
      userId: personId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });
    expect((await lastOf(personId))?.updatedAt).toEqual(first?.updatedAt);

    await rememberWorkspace({
      userId: personId,
      organizationId: fx.organizationId,
      teamId: second.id,
    });
    expect(await lastOf(personId)).toMatchObject({ teamId: second.id });
  });

  test("reopens its team while it is theirs, else their only team, else none", async () => {
    const personId = await fx.addPerson();
    const second = await fx.createTeam();
    await db
      .insert(teamMember)
      .values({ userId: personId, teamId: second.id, createdAt: new Date() });
    await rememberWorkspace({
      userId: personId,
      organizationId: fx.organizationId,
      teamId: second.id,
    });

    expect(await workspaceToReopen(personId)).toEqual({
      organizationId: fx.organizationId,
      teamId: second.id,
    });

    // Out of that team, one team left: that one opens.
    await leaveTeam(personId, second.id);
    expect(await workspaceToReopen(personId)).toEqual({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });

    // In no team at all: the organization, and the app asks.
    await leaveTeam(personId, fx.teamId);
    expect(await workspaceToReopen(personId)).toEqual({
      organizationId: fx.organizationId,
      teamId: null,
    });
  });

  test("opens a guest's access with no team, whatever a stray row says", async () => {
    const guestId = await fx.addPerson({ role: "guest", inTeam: true });
    await rememberWorkspace({
      userId: guestId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });

    expect(await workspaceToReopen(guestId)).toEqual({
      organizationId: fx.organizationId,
      teamId: null,
    });
  });

  test("never reopens an organization they left, and forgets it once they have", async () => {
    const personId = await fx.addPerson();
    await rememberWorkspace({
      userId: personId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });

    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, fx.organizationId),
          eq(member.userId, personId),
        ),
      );
    expect(await workspaceToReopen(personId)).toBeNull();

    await onMemberLeftOrganization({
      organizationId: fx.organizationId,
      userId: personId,
    });
    expect(await lastOf(personId)).toBeNull();
  });
});

describe("a new session", () => {
  const PASSWORD = "integration-password-1";

  /** `set-cookie` lines folded into the `cookie` header a next call sends. */
  const cookieOf = (headers: Headers): Headers =>
    new Headers({
      cookie: headers
        .getSetCookie()
        .map((line) => line.split(";")[0] ?? "")
        .filter(Boolean)
        .join("; "),
    });

  /**
   * An account with a password, a member of the workspace in its first team.
   * Sign-up is gated (closed beta): a pending invitation presented by id opens
   * the gate and verifies the address, as the invitation page does.
   */
  const createAccount = async (): Promise<{ id: string; email: string }> => {
    const email = `it-last-${randomUUID().slice(0, 8)}@example.test`;
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
    if (!bootstrap) throw new Error("fixture: no signup invitation");
    const signUp = await auth.api.signUpEmail({
      body: { name: "Integration user", email, password: PASSWORD },
      headers: new Headers({ [SIGNUP_INVITATION_HEADER]: bootstrap.id }),
    });
    accounts.push(signUp.user.id);
    await db
      .update(invitation)
      .set({ status: "canceled" })
      .where(eq(invitation.id, bootstrap.id));
    await db.insert(member).values({
      organizationId: fx.organizationId,
      userId: signUp.user.id,
      role: "member",
      createdAt: new Date(),
    });
    await db.insert(teamMember).values({
      teamId: fx.teamId,
      userId: signUp.user.id,
      createdAt: new Date(),
    });
    return { id: signUp.user.id, email };
  };

  const signIn = async (email: string): Promise<Headers> => {
    const signedIn = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    return cookieOf(signedIn.headers);
  };

  const workspaceOf = async (headers: Headers) => {
    const current = await auth.api.getSession({ headers });
    return {
      organizationId: current?.session.activeOrganizationId ?? null,
      teamId: current?.session.activeTeamId ?? null,
    };
  };

  test("opens where the previous one was left", async () => {
    const account = await createAccount();
    const second = await fx.createTeam();
    await db
      .insert(teamMember)
      .values({ userId: account.id, teamId: second.id, createdAt: new Date() });

    const first = await signIn(account.email);
    // Nothing remembered yet: the first session opens nowhere, and the app asks.
    expect(await workspaceOf(first)).toEqual({
      organizationId: null,
      teamId: null,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: fx.organizationId },
      headers: first,
    });
    await auth.api.setActiveTeam({
      body: { teamId: second.id },
      headers: first,
    });

    const next = await signIn(account.email);
    expect(await workspaceOf(next)).toEqual({
      organizationId: fx.organizationId,
      teamId: second.id,
    });
  });
});
