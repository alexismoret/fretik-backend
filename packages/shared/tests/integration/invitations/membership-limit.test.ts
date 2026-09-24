import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { invitation, member, user } from "../../../src/db/schema";
import { MAX_PEOPLE_PER_ORGANIZATION } from "../../../src/lib/auth-constants";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * The membership limit (`services/organization/membership-limit.ts`): an
 * organization holds so many people, and the teams' agents and the guests
 * take no seat. Better Auth enforces it when an invitation is accepted, so
 * the invitees here join the way the invitation page has them join: signing
 * up from the link and accepting, through Better Auth's own endpoints.
 */

// Signing up sends a verification code; nothing here is about it.
await mockModule("../../src/lib/email", {
  sendEmail: () => Promise.resolve(),
});

const { auth } = await import("../../../src/lib/auth");
const { SIGNUP_INVITATION_HEADER } =
  await import("../../../src/services/auth/signup-gate");
const { membershipLimitFor } =
  await import("../../../src/services/organization/membership-limit");

const PASSWORD = "integration-password-1";
const DAY = 24 * 60 * 60 * 1000;

let fx: WorkspaceFixture;
/** The accounts made here, which the organization's cleanup does not reach. */
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

const tag = (): string => randomUUID().slice(0, 8);

/** Members of the organization, written straight to the tables. */
const seat = async (
  role: "member" | "guest" | "bot",
  howMany: number,
): Promise<void> => {
  const rows = await db
    .insert(user)
    .values(
      Array.from({ length: howMany }, () => {
        const id = tag();
        return {
          name: `Seat ${id}`,
          email: `it-seat-${id}@example.test`,
          emailVerified: true,
        };
      }),
    )
    .returning({ id: user.id });
  accounts.push(...rows.map((row) => row.id));
  await db.insert(member).values(
    rows.map((row) => ({
      userId: row.id,
      organizationId: fx.organizationId,
      role,
      createdAt: new Date(),
    })),
  );
};

const invite = async (
  email: string,
  role: "member" | "guest",
): Promise<string> => {
  const [row] = await db
    .insert(invitation)
    .values({
      organizationId: fx.organizationId,
      email,
      role,
      status: "pending",
      expiresAt: new Date(Date.now() + DAY),
      inviterId: fx.userIds[0],
    })
    .returning({ id: invitation.id });
  if (!row) throw new Error("fixture: no invitation");
  return row.id;
};

const cookieHeader = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");

/** Signs up from the invitation's link and accepts it; the refusal, if any. */
const joinFromLink = async (
  email: string,
  invitationId: string,
): Promise<string | null> => {
  const signUp = await auth.api.signUpEmail({
    body: { name: "Newcomer", email, password: PASSWORD },
    headers: new Headers({ [SIGNUP_INVITATION_HEADER]: invitationId }),
  });
  accounts.push(signUp.user.id);
  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return auth.api
    .acceptInvitation({
      body: { invitationId },
      headers: new Headers({ cookie: cookieHeader(signIn.headers) }),
    })
    .then(
      () => null,
      (error: unknown) => JSON.stringify(error),
    );
};

const roleOf = async (email: string): Promise<string | null> => {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(eq(member.organizationId, fx.organizationId), eq(user.email, email)),
    );
  return row?.role ?? null;
};

describe("the membership limit", () => {
  test("counts people, not the teams' agents nor the guests", async () => {
    await seat("bot", 3);
    await seat("guest", 4);
    expect(
      await membershipLimitFor({
        organizationId: fx.organizationId,
        email: `it-${tag()}@example.test`,
      }),
    ).toBe(MAX_PEOPLE_PER_ORGANIZATION + 7);
  });

  test("a full organization takes no one more as a member, and still takes a guest", async () => {
    // The fixture's two people, and as many more as it takes to fill it;
    // agents and guests beside them, which fill nothing.
    await seat("member", MAX_PEOPLE_PER_ORGANIZATION - 2);
    await seat("bot", 2);
    await seat("guest", 2);

    const person = `it-person-${tag()}@example.test`;
    const refusal = await joinFromLink(person, await invite(person, "member"));
    expect(refusal).toContain("ORGANIZATION_MEMBERSHIP_LIMIT_REACHED");
    expect(await roleOf(person)).toBeNull();

    const guest = `it-guest-${tag()}@example.test`;
    expect(await joinFromLink(guest, await invite(guest, "guest"))).toBeNull();
    expect(await roleOf(guest)).toBe("guest");
  });

  test("one seat left is taken, whatever the agents and guests", async () => {
    await seat("member", MAX_PEOPLE_PER_ORGANIZATION - 3);
    await seat("bot", 5);
    await seat("guest", 5);

    const person = `it-person-${tag()}@example.test`;
    expect(
      await joinFromLink(person, await invite(person, "member")),
    ).toBeNull();
    expect(await roleOf(person)).toBe("member");
  });
});
