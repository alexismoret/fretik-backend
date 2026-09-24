import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import db from "../../../src/db";
import { accessAuditLog, accessGrants, member } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * Guests whose access has ended leave the organization
 * (`services/access/guests/remove-expired-guests.ts`, the hourly sweep of the
 * jobs process): once every share has run out, and only then.
 */

// The departure's own steps reach the email transport; nothing here is about it.
await mockModule("../../src/lib/email", {
  sendEmail: () => Promise.resolve(),
});
const { removeExpiredGuests, GUEST_ACCESS_ENDED } =
  await import("../../../src/services/access/guests/remove-expired-guests");

const HOUR = 60 * 60 * 1000;

let fx: WorkspaceFixture;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

/** A share to this person of a page of the workspace, ending when given. */
const shareUntil = async (userId: string, expiresAt: Date | null) => {
  const page = await fx.createPage();
  await db.insert(accessGrants).values({
    organizationId: fx.organizationId,
    resourceType: "page",
    resourceId: page.id,
    principalType: "user",
    principalId: userId,
    level: "view",
    expiresAt,
  });
};

const stillIn = async (userId: string): Promise<boolean> =>
  (await db.query.member.findFirst({
    columns: { id: true },
    where: { organizationId: fx.organizationId, userId },
  })) !== undefined;

describe("the guest expiry sweep", () => {
  test("removes a guest whose every share has run out, and journals why", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    await shareUntil(guestId, new Date(Date.now() - HOUR));
    await shareUntil(guestId, new Date(Date.now() - 2 * HOUR));

    await removeExpiredGuests();

    expect(await stillIn(guestId)).toBe(false);
    const [entry] = await db
      .select({
        actorUserId: accessAuditLog.actorUserId,
        metadata: accessAuditLog.metadata,
      })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "member.removed"),
          eq(accessAuditLog.principalId, guestId),
        ),
      );
    expect(entry).toMatchObject({
      actorUserId: null,
      metadata: { role: "guest", reason: GUEST_ACCESS_ENDED },
    });
  });

  test("keeps a guest with a share still running, whatever else ran out", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    await shareUntil(guestId, new Date(Date.now() - HOUR));
    await shareUntil(guestId, new Date(Date.now() + HOUR));
    const openEnded = await fx.addPerson({ role: "guest" });
    await shareUntil(openEnded, new Date(Date.now() - HOUR));
    await shareUntil(openEnded, null);

    await removeExpiredGuests();

    expect(await stillIn(guestId)).toBe(true);
    expect(await stillIn(openEnded)).toBe(true);
  });

  test("leaves to an admin a guest whose shares were withdrawn, and never touches a member", async () => {
    // Nothing shared at all: withdrawn by hand, not run out.
    const withdrawn = await fx.addPerson({ role: "guest" });
    // A member whose share of something ran out is still a member.
    const [, memberId] = fx.userIds;
    await shareUntil(memberId, new Date(Date.now() - HOUR));

    await removeExpiredGuests();

    expect(await stillIn(withdrawn)).toBe(true);
    expect(await stillIn(memberId)).toBe(true);
    expect(
      await db.$count(member, eq(member.organizationId, fx.organizationId)),
    ).toBe(3);
  });
});
