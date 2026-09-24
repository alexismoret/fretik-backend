import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  accessAuditLog,
  accessGrants,
  aiConversationMembers,
  documents,
  invitation,
  member,
  projects,
  signupAllowlist,
  teamMember,
  user,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Guests — people from outside the organization, invited by email onto what
 * they will see.
 *
 * The share dialog's "Invite" box (`services/access/guests/invite-guests.ts`)
 * gives someone of the organization access at once, and invites anyone else
 * as a guest, whose access waits in an `invitation` grant until they accept.
 * Accepting goes through Better Auth's own endpoint — the hooks are the
 * subject as much as the services — so those tests sign up and accept for
 * real (`auth.api.*`, the dispatch the HTTP router uses). The doubles are
 * the email transport — the assertions on it are about WHICH message went —
 * and the file store and sandbox a deleted chat is cleared from.
 */

/** Every message sent, in order. */
const sent: { to: string; subject: string; html: string }[] = [];

await mockModule("../../src/lib/email", {
  sendEmail: (options: {
    to: { email: string };
    subject: string;
    html: string;
  }) => {
    sent.push({
      to: options.to.email,
      subject: options.subject,
      html: options.html,
    });
    return Promise.resolve();
  },
});
// Deleting a chat also clears its files and its sandbox, which live with
// providers: nothing here is about them.
await mockModule("../../src/lib/chatbot-session-storage", {
  deleteSessionFolder: () => Promise.resolve(),
});
await mockModule("../../src/services/e2b/kill-sandbox", {
  killSandbox: () => Promise.resolve(),
});

const { auth } = await import("../../../src/lib/auth");
const { resolveAccess } = await import("../../../src/authz/access");
const { SIGNUP_INVITATION_HEADER } =
  await import("../../../src/services/auth/signup-gate");
const { inviteGuests } =
  await import("../../../src/services/access/guests/invite-guests");
const { describeResourceAccess } =
  await import("../../../src/services/access/sharing/describe");
const { revokeGrant } =
  await import("../../../src/services/access/sharing/revoke-grant");
const { changeGrantLevel } =
  await import("../../../src/services/access/sharing/change-grant-level");
const { shareResource } =
  await import("../../../src/services/access/sharing/share");
const { updateOrganizationPolicy } =
  await import("../../../src/services/access/update-organization-policy");
const { cancelInvitation } =
  await import("../../../src/services/invitations/cancel");
const { setOrganizationRole } =
  await import("../../../src/services/members/set-role");
const { listConversations } = await import("../../../src/services/ai/list");
const { deleteConversations } = await import("../../../src/services/ai/delete");
const { listWorkspaces } =
  await import("../../../src/services/workspaces/list-workspaces");
const { projectsTakenPartIn } = await import("../../../src/authz/principal");

const PASSWORD = "integration-password-1";

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  sent.length = 0;
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
});

afterEach(async () => {
  await fx.cleanup();
});

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

const insertDocument = async (): Promise<{ id: string; name: string }> => {
  const name = `quote-${randomUUID().slice(0, 8)}.pdf`;
  const [row] = await db
    .insert(documents)
    .values({
      teamId: fx.teamId,
      status: "ready",
      originalFilename: name,
      fileSize: 1024,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
      ownerUserId: ownerId,
      uploadedById: ownerId,
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: no document");
  return { id: row.id, name };
};

const outsider = (): string =>
  `it-guest-${randomUUID().slice(0, 8)}@client.example`;

/** The organization's pending invitations to an address. */
const invitationsTo = async (email: string) =>
  db
    .select()
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, fx.organizationId),
        eq(invitation.email, email),
      ),
    );

const grantsOn = async (resourceId: string) =>
  db
    .select({
      principalType: accessGrants.principalType,
      principalId: accessGrants.principalId,
      level: accessGrants.level,
      expiresAt: accessGrants.expiresAt,
    })
    .from(accessGrants)
    .where(eq(accessGrants.resourceId, resourceId));

/** `set-cookie` lines folded into the `cookie` header a next call must send. */
const cookieHeader = (headers: Headers): string =>
  headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");

/**
 * The invitee signs up from the emailed link (presenting the invitation's id
 * opens the closed beta and verifies the address) and signs in.
 */
const signUpFromLink = async (
  email: string,
  invitationId: string,
): Promise<{ userId: string; headers: Headers }> => {
  const signUp = await auth.api.signUpEmail({
    body: { name: "Client contact", email, password: PASSWORD },
    headers: new Headers({ [SIGNUP_INVITATION_HEADER]: invitationId }),
  });
  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return {
    userId: signUp.user.id,
    headers: new Headers({ cookie: cookieHeader(signIn.headers) }),
  };
};

const levelOf = async (userId: string, id: string) =>
  (await resolveAccess(await fx.principalOf(userId), "document", id))?.level ??
  null;

describe("inviting an outside address", () => {
  test("invites them as a guest, and the item waits for their yes", async () => {
    const doc = await insertDocument();
    const email = outsider();

    const result = await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email.toUpperCase()],
      level: "edit",
    });

    expect(result.outcomes).toEqual([{ email, status: "invited" }]);
    const [sentInvitation] = await invitationsTo(email);
    expect(sentInvitation).toMatchObject({
      role: "guest",
      teamId: null,
      status: "pending",
    });
    // The email names the item, not the organization.
    expect(sent.map((message) => message.to)).toEqual([email]);
    expect(sent[0]?.subject).toContain(doc.name);
    // The grant waits on the invitation, and gives nobody anything yet.
    expect(await grantsOn(doc.id)).toEqual([
      {
        principalType: "invitation",
        principalId: sentInvitation?.id ?? "",
        level: "edit",
        expiresAt: null,
      },
    ]);
    // Whoever manages access sees the address waiting.
    expect(
      result.access.holders.map((holder) => ({
        type: holder.principalType,
        name: holder.name,
        guest: holder.guest,
        level: holder.level,
      })),
    ).toEqual([
      { type: "invitation", name: email, guest: true, level: "edit" },
    ]);
    expect(await journal("invitation.sent")).toHaveLength(1);
  });

  test("words taking part in a project as the share dialog does", async () => {
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        name: `project-${randomUUID().slice(0, 8)}`,
        ownerUserId: ownerId,
      })
      .returning({ id: projects.id });
    if (!project) throw new Error("fixture: no project");

    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "project",
      id: project.id,
      emails: [outsider()],
      level: "use",
    });
    // Using a project is taking part in it ("Can take part"), not "using" it.
    expect(sent[0]?.html).toContain("invited you to take part in");
  });

  test("never gives a guest full access, nor a seat in a chat of a team", async () => {
    const doc = await insertDocument();
    expect(
      await refusal(
        inviteGuests({
          principal: await fx.principalOf(ownerId),
          type: "document",
          id: doc.id,
          emails: [outsider()],
          level: "full",
        }),
      ),
    ).toEqual({ status: 400, code: "GUEST_LEVEL_CEILING" });

    const chat = await fx.createConversation({ userId: ownerId });
    expect(
      await refusal(
        inviteGuests({
          principal: await fx.principalOf(ownerId),
          type: "conversation",
          id: chat.id,
          emails: [outsider()],
          level: "use",
        }),
      ),
    ).toEqual({ status: 400, code: "GUEST_LEVEL_CEILING" });
    // Nothing half-done: no invitation went out.
    expect(sent).toEqual([]);
  });

  test("follows the guest policy: its admins by default, then whoever it names", async () => {
    const doc = await insertDocument();
    const email = outsider();
    // Under the default team policy a member has full access to the team's
    // content, so only the guest policy stands in the way.
    expect(
      await refusal(
        inviteGuests({
          principal: await fx.principalOf(memberId),
          type: "document",
          id: doc.id,
          emails: [email],
          level: "view",
        }),
      ),
    ).toMatchObject({ status: 403 });

    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { guestInvitations: "members" },
    });
    const result = await inviteGuests({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });
    expect(result.outcomes).toEqual([{ email, status: "invited" }]);
  });

  test("gives someone of the organization access at once, with no invitation", async () => {
    const doc = await insertDocument();
    const colleague = await db.query.user.findFirst({
      columns: { email: true },
      where: { id: memberId },
    });
    const email = colleague?.email ?? "";

    const result = await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });

    expect(result.outcomes).toEqual([{ email, status: "shared" }]);
    expect(await invitationsTo(email)).toEqual([]);
    expect(await grantsOn(doc.id)).toEqual([
      {
        principalType: "user",
        principalId: memberId,
        level: "view",
        expiresAt: null,
      },
    ]);
  });
});

describe("accepting", () => {
  test("turns what was waiting into the guest's own access", async () => {
    const doc = await insertDocument();
    const email = outsider();
    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "edit",
    });
    const [sentInvitation] = await invitationsTo(email);
    if (!sentInvitation) throw new Error("no invitation");

    const guest = await signUpFromLink(email, sentInvitation.id);
    await auth.api.acceptInvitation({
      body: { invitationId: sentInvitation.id },
      headers: guest.headers,
    });

    const membership = await db.query.member.findFirst({
      columns: { role: true },
      where: { organizationId: fx.organizationId, userId: guest.userId },
    });
    expect(membership?.role).toBe("guest");
    expect(await grantsOn(doc.id)).toEqual([
      {
        principalType: "user",
        principalId: guest.userId,
        level: "edit",
        expiresAt: null,
      },
    ]);
    expect(await levelOf(guest.userId, doc.id)).toBe("edit");
    // A guest sees what is shared with them, and nothing their team would.
    const other = await insertDocument();
    expect(await levelOf(guest.userId, other.id)).toBeNull();
    expect(await journal("invitation.accepted")).toHaveLength(1);
  });

  test("a guest's access ends with the organization's period", async () => {
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { guestAccessDays: 30 },
    });
    const doc = await insertDocument();
    const email = outsider();
    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });
    const [sentInvitation] = await invitationsTo(email);
    if (!sentInvitation) throw new Error("no invitation");
    const guest = await signUpFromLink(email, sentInvitation.id);
    await auth.api.acceptInvitation({
      body: { invitationId: sentInvitation.id },
      headers: guest.headers,
    });

    const [grant] = await grantsOn(doc.id);
    const days =
      ((grant?.expiresAt?.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    // Past it, the grant gives nothing.
    await db
      .update(accessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accessGrants.resourceId, doc.id));
    expect(await levelOf(guest.userId, doc.id)).toBeNull();
  });

  test("declining drops what was waiting", async () => {
    const doc = await insertDocument();
    const email = outsider();
    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });
    const [sentInvitation] = await invitationsTo(email);
    if (!sentInvitation) throw new Error("no invitation");
    const guest = await signUpFromLink(email, sentInvitation.id);

    await auth.api.rejectInvitation({
      body: { invitationId: sentInvitation.id },
      headers: guest.headers,
    });

    expect(await grantsOn(doc.id)).toEqual([]);
    expect(await journal("invitation.rejected")).toHaveLength(1);
  });
});

describe("someone with an account in another organization", () => {
  test("is invited like anyone, signs in rather than up, and keeps their own organization", async () => {
    const elsewhere = await createWorkspaceFixture();
    const email = outsider();
    let userId: string | null = null;
    try {
      // Their own account, in their own organization, in French.
      await db.insert(signupAllowlist).values({ email });
      const signUp = await auth.api.signUpEmail({
        body: { name: "Paul Elsewhere", email, password: PASSWORD },
      });
      userId = signUp.user.id;
      await db
        .update(user)
        .set({ emailVerified: true, language: "fr" })
        .where(eq(user.id, userId));
      await db.insert(member).values({
        userId,
        organizationId: elsewhere.organizationId,
        role: "member",
        createdAt: new Date(),
      });
      await db
        .insert(teamMember)
        .values({ userId, teamId: elsewhere.teamId, createdAt: new Date() });
      const signIn = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        returnHeaders: true,
      });
      const headers = new Headers({ cookie: cookieHeader(signIn.headers) });
      sent.length = 0;

      const doc = await insertDocument();
      const result = await inviteGuests({
        principal: await fx.principalOf(ownerId),
        type: "document",
        id: doc.id,
        emails: [email],
        level: "view",
      });

      // Whether the address has an account is not the inviter's to learn.
      expect(result.outcomes).toEqual([{ email, status: "invited" }]);
      // The email, to that address alone, is in their language and says to
      // sign in with the account they have.
      expect(sent.map((message) => message.to)).toEqual([email]);
      expect(sent[0]?.subject).toContain("a partagé");
      expect(sent[0]?.html).toContain("Vous avez déjà un compte Fretik");

      // Signed in, they find it in the app before opening any email.
      const [sentInvitation] = await invitationsTo(email);
      if (!sentInvitation) throw new Error("no invitation");
      const before = await listWorkspaces({
        userId,
        email,
        emailVerified: true,
      });
      expect(
        before.invitations.map((waiting) => ({
          id: waiting.id,
          role: waiting.role,
          alreadyMember: waiting.alreadyMember,
          items: waiting.items.map((item) => item.id),
        })),
      ).toEqual([
        {
          id: sentInvitation.id,
          role: "guest",
          alreadyMember: false,
          items: [doc.id],
        },
      ]);

      await auth.api.acceptInvitation({
        body: { invitationId: sentInvitation.id },
        headers,
      });

      // A guest here, still a member of their own, with one account.
      const after = await listWorkspaces({
        userId,
        email,
        emailVerified: true,
      });
      expect(after.invitations).toEqual([]);
      const byOrganization = (a: { id: string }, b: { id: string }) =>
        a.id.localeCompare(b.id);
      expect(
        after.memberships
          .map((m) => ({
            id: m.organization.id,
            role: m.role,
            teams: m.teams.map((t) => t.id),
          }))
          .sort(byOrganization),
      ).toEqual(
        [
          { id: fx.organizationId, role: "guest" as const, teams: [] },
          {
            id: elsewhere.organizationId,
            role: "member" as const,
            teams: [elsewhere.teamId],
          },
        ].sort(byOrganization),
      );
      expect(await levelOf(userId, doc.id)).toBe("view");
    } finally {
      if (userId !== null) await db.delete(user).where(eq(user.id, userId));
      await db.delete(signupAllowlist).where(eq(signupAllowlist.email, email));
      await elsewhere.cleanup();
    }
  });
});

describe("a guest in the organization", () => {
  test("is shared with directly, for the guest period, and told by email", async () => {
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { guestAccessDays: 7 },
    });
    const guestId = await fx.addPerson({ role: "guest" });
    const guestEmail =
      (
        await db.query.user.findFirst({
          columns: { email: true },
          where: { id: guestId },
        })
      )?.email ?? "";
    const doc = await insertDocument();

    const result = await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [guestEmail],
      level: "view",
    });

    expect(result.outcomes).toEqual([{ email: guestEmail, status: "shared" }]);
    const [grant] = await grantsOn(doc.id);
    expect(grant?.principalId).toBe(guestId);
    expect(grant?.expiresAt).not.toBeNull();
    expect(sent.map((message) => message.to)).toEqual([guestEmail]);
    // The dialog flags them, and says when their access ends.
    const holder = result.access.holders.find(
      (row) => row.principalId === guestId,
    );
    expect(holder).toMatchObject({ guest: true, principalType: "user" });
    expect(holder?.expiresAt).not.toBeNull();
  });

  test("is held to a guest's ceiling from the people picker too", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    const doc = await insertDocument();
    expect(
      await refusal(
        shareResource({
          principal: await fx.principalOf(ownerId),
          type: "document",
          id: doc.id,
          principals: [{ type: "user", id: guestId }],
          level: "full",
        }),
      ),
    ).toEqual({ status: 400, code: "GUEST_LEVEL_CEILING" });

    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      principals: [{ type: "user", id: guestId }],
      level: "view",
    });
    expect(
      await refusal(
        changeGrantLevel({
          principal: await fx.principalOf(ownerId),
          type: "document",
          id: doc.id,
          holder: { type: "user", id: guestId },
          level: "full",
        }),
      ),
    ).toEqual({ status: 400, code: "GUEST_LEVEL_CEILING" });
  });

  test("becomes a member when an admin says so, and their access stops ending", async () => {
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { guestAccessDays: 7 },
    });
    const guestId = await fx.addPerson({ role: "guest" });
    const doc = await insertDocument();
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      principals: [{ type: "user", id: guestId }],
      level: "view",
    });

    await setOrganizationRole({
      principal: await fx.principalOf(ownerId),
      userId: guestId,
      role: "member",
    });

    const [grant] = await grantsOn(doc.id);
    expect(grant?.expiresAt).toBeNull();
    const membership = await db.query.member.findFirst({
      columns: { role: true },
      where: { organizationId: fx.organizationId, userId: guestId },
    });
    expect(membership?.role).toBe("member");
  });

  test("sees only themselves through Better Auth's directory endpoints", async () => {
    const doc = await insertDocument();
    const email = outsider();
    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });
    const [sentInvitation] = await invitationsTo(email);
    if (!sentInvitation) throw new Error("no invitation");
    const guest = await signUpFromLink(email, sentInvitation.id);
    await auth.api.acceptInvitation({
      body: { invitationId: sentInvitation.id },
      headers: guest.headers,
    });

    const organization = await auth.api.getFullOrganization({
      headers: guest.headers,
      query: { organizationId: fx.organizationId },
    });
    expect(organization?.members.map((row) => row.userId)).toEqual([
      guest.userId,
    ]);
    expect(organization?.invitations).toEqual([]);

    const members = await auth.api.listMembers({
      headers: guest.headers,
      query: { organizationId: fx.organizationId },
    });
    expect(members.members.map((row) => row.userId)).toEqual([guest.userId]);
    expect(
      await auth.api.listInvitations({
        headers: guest.headers,
        query: { organizationId: fx.organizationId },
      }),
    ).toEqual([]);
    expect(
      await auth.api.listOrganizationTeams({
        headers: guest.headers,
        query: { organizationId: fx.organizationId },
      }),
    ).toEqual([]);

    // A member still reads the whole directory.
    const people = await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, fx.organizationId));
    expect(people.length).toBeGreaterThan(1);
  });
});

describe("taking an invitation back", () => {
  test("removing the last item a guest was invited to withdraws the invitation", async () => {
    const doc = await insertDocument();
    const email = outsider();
    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });
    const [sentInvitation] = await invitationsTo(email);
    if (!sentInvitation) throw new Error("no invitation");

    const model = await revokeGrant({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      holder: { type: "invitation", id: sentInvitation.id },
    });

    expect(model?.holders).toEqual([]);
    expect(await grantsOn(doc.id)).toEqual([]);
    const [after] = await invitationsTo(email);
    expect(after?.status).toBe("canceled");
  });

  test("changing a waiting invitation's level keeps it to a guest's ceiling", async () => {
    const doc = await insertDocument();
    const email = outsider();
    await inviteGuests({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      emails: [email],
      level: "view",
    });
    const [sentInvitation] = await invitationsTo(email);
    if (!sentInvitation) throw new Error("no invitation");
    const holder = { type: "invitation" as const, id: sentInvitation.id };

    const model = await changeGrantLevel({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      holder,
      level: "edit",
    });
    expect(model.holders[0]?.level).toBe("edit");
    expect(
      await refusal(
        changeGrantLevel({
          principal: await fx.principalOf(ownerId),
          type: "document",
          id: doc.id,
          holder,
          level: "full",
        }),
      ),
    ).toEqual({ status: 400, code: "GUEST_LEVEL_CEILING" });
  });

  test("withdrawing the invitation drops everything it was sent for", async () => {
    const first = await insertDocument();
    const second = await insertDocument();
    const email = outsider();
    const owner = await fx.principalOf(ownerId);
    const invite = (id: string) =>
      inviteGuests({
        principal: owner,
        type: "document",
        id,
        emails: [email],
        level: "view",
      });
    await invite(first.id);
    await invite(second.id);
    // One invitation, naming both items: the second share joined the first.
    const invitations = await invitationsTo(email);
    expect(invitations).toHaveLength(1);
    const [sentInvitation] = invitations;
    if (!sentInvitation) throw new Error("no invitation");
    expect(sent).toHaveLength(2);

    await cancelInvitation({
      principal: await fx.principalOf(ownerId),
      invitationId: sentInvitation.id,
    });

    expect(await grantsOn(first.id)).toEqual([]);
    expect(await grantsOn(second.id)).toEqual([]);
  });

  test("a guest reads who else has access as themselves alone", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    const doc = await insertDocument();
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc.id,
      principals: [
        { type: "user", id: guestId },
        { type: "user", id: memberId },
      ],
      level: "view",
    });
    const model = await describeResourceAccess({
      principal: await fx.principalOf(guestId),
      type: "document",
      id: doc.id,
    });
    expect(model.canManage).toBe(false);
    expect(model.holders.map((holder) => holder.principalId)).toEqual([
      guestId,
    ]);
  });
});

describe("a guest's own chats", () => {
  /**
   * A project of the team the guest takes part in until `until`, with a chat
   * of it the guest owns.
   */
  const guestChatInProject = async (guestId: string, until?: Date) => {
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        name: `project-${randomUUID().slice(0, 8)}`,
        ownerUserId: ownerId,
      })
      .returning({ id: projects.id });
    if (!project) throw new Error("fixture: no project");
    await db.insert(accessGrants).values({
      organizationId: fx.organizationId,
      resourceType: "project",
      resourceId: project.id,
      principalType: "user",
      principalId: guestId,
      level: "use",
      expiresAt: until ?? null,
    });
    const chat = await fx.createConversation({
      userId: guestId,
      projectId: project.id,
    });
    await db.insert(aiConversationMembers).values({
      conversationId: chat.id,
      userId: guestId,
      role: "owner",
    });
    return { chatId: chat.id, projectId: project.id };
  };

  /** A guest's chats, from the projects they take part in. */
  const chatsOf = async (guestId: string) =>
    (
      await listConversations({
        scope: {
          organizationId: fx.organizationId,
          projectIds: projectsTakenPartIn(await fx.principalOf(guestId)),
        },
        userId: guestId,
        agentType: "chatbot",
        params: { limit: 20, page: 0 },
      })
    ).data.map((row) => row.id);

  test("are listed from the projects they take part in, having no team to list them from", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    const { chatId } = await guestChatInProject(guestId);
    // Someone else's chat of the team is not the guest's to list.
    await fx.createConversation({ userId: ownerId });

    expect(await chatsOf(guestId)).toEqual([chatId]);
  });

  test("end with their part in the project, seats and their own chats alike", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    const { chatId, projectId } = await guestChatInProject(
      guestId,
      new Date(Date.now() + 60_000),
    );
    // Seated in a colleague's chat of the same project, beside a member of
    // the organization who works neither in its team nor in the project.
    const elsewhere = await fx.addPerson({ inTeam: false });
    const colleagues = await fx.createConversation({
      userId: ownerId,
      projectId,
    });
    await db.insert(aiConversationMembers).values([
      { conversationId: colleagues.id, userId: ownerId, role: "owner" },
      { conversationId: colleagues.id, userId: guestId, role: "member" },
      { conversationId: colleagues.id, userId: elsewhere, role: "member" },
    ]);
    const levelIn = async (userId: string, id: string) =>
      (await resolveAccess(await fx.principalOf(userId), "conversation", id))
        ?.level ?? null;
    expect(await levelIn(guestId, chatId)).toBe("full");
    expect(await levelIn(guestId, colleagues.id)).toBe("use");

    // Their period ends.
    await db
      .update(accessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accessGrants.principalId, guestId));

    expect(await chatsOf(guestId)).toEqual([]);
    expect(await levelIn(guestId, chatId)).toBeNull();
    expect(await levelIn(guestId, colleagues.id)).toBeNull();
    // A member who does not work there reads a chat they were seated in:
    // the rule is a guest's alone.
    expect(await levelIn(elsewhere, colleagues.id)).toBe("view");
  });

  test("are theirs to delete, and nobody else's chat is", async () => {
    const guestId = await fx.addPerson({ role: "guest" });
    const { chatId } = await guestChatInProject(guestId);
    const others = await fx.createConversation({ userId: ownerId });
    await db.insert(aiConversationMembers).values({
      conversationId: others.id,
      userId: ownerId,
      role: "owner",
    });

    const result = await deleteConversations({
      ids: [chatId, others.id],
      organizationId: fx.organizationId,
      userId: guestId,
    });
    expect(result.rowCount).toBe(1);
  });
});
