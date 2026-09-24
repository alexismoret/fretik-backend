import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { accessAuditLog, invitation } from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Inviting people into a team through our own door — decided by the
 * organization's policy (`members.invite`), not by Better Auth's organization
 * roles — and taking an invitation back.
 *
 * The only double is the email transport: which messages left, and one
 * address it can be told to refuse.
 */

const sent: string[] = [];
const undeliverable = new Set<string>();

await mockModule("../../src/lib/email", {
  sendEmail: (options: { to: { email: string } }) => {
    if (undeliverable.has(options.to.email)) {
      return Promise.reject(new Error("mailbox unavailable"));
    }
    sent.push(options.to.email);
    return Promise.resolve();
  },
});

const { inviteToTeam } =
  await import("../../../src/services/invitations/invite-to-team");
const { listPendingInvitations } =
  await import("../../../src/services/invitations/list-pending");
const { cancelInvitation } =
  await import("../../../src/services/invitations/cancel");
const { updateOrganizationPolicy } =
  await import("../../../src/services/access/update-organization-policy");
const { createTeam } = await import("../../../src/services/team/create");
const { addTeamMembers } =
  await import("../../../src/services/team/add-members");

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  sent.length = 0;
  undeliverable.clear();
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

const newAddress = (): string =>
  `it-invitee-${randomUUID().slice(0, 8)}@example.test`;

const invitationsTo = (email: string) =>
  db
    .select({
      id: invitation.id,
      status: invitation.status,
      role: invitation.role,
      teamId: invitation.teamId,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, fx.organizationId),
        eq(invitation.email, email),
      ),
    );

/** A real team the owner leads, with the fixture's member in it as `role`. */
const teamWithMember = async (
  role: "lead" | "member" | "viewer",
): Promise<string> => {
  const owner = await fx.principalOf(ownerId);
  const created = await createTeam({ principal: owner, name: "Sales" });
  await addTeamMembers({
    principal: owner,
    teamId: created.id,
    userIds: [memberId],
    role,
  });
  return created.id;
};

const emailOf = async (userId: string): Promise<string> => {
  const row = await db.query.user.findFirst({
    columns: { email: true },
    where: { id: userId },
  });
  if (!row) throw new Error("no such user");
  return row.email;
};

describe("who may invite", () => {
  test("by default the admins; a team's leads once the organization says so", async () => {
    const teamId = await teamWithMember("lead");
    const address = newAddress();
    const lead = await fx.principalOf(memberId);

    expect(
      await refusal(
        inviteToTeam({
          principal: lead,
          teamId,
          invitations: [{ email: address, role: "member" }],
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });

    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { memberInvitations: "leads" },
    });
    const outcomes = await inviteToTeam({
      principal: await fx.principalOf(memberId),
      teamId,
      invitations: [{ email: address, role: "member" }],
    });

    expect(outcomes).toEqual([
      { email: address, status: "invited", invitationId: expect.any(String) },
    ]);
    expect(await invitationsTo(address)).toEqual([
      { id: expect.any(String), status: "pending", role: "member", teamId },
    ]);
    expect(sent).toEqual([address]);
    const entries = await db
      .select()
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.action, "invitation.sent"),
        ),
      );
    expect(entries.map((e) => e.actorUserId)).toEqual([memberId]);
  });

  test("making someone an admin stays the admins' call", async () => {
    const teamId = await teamWithMember("lead");
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { memberInvitations: "leads" },
    });

    expect(
      await refusal(
        inviteToTeam({
          principal: await fx.principalOf(memberId),
          teamId,
          invitations: [{ email: newAddress(), role: "admin" }],
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    expect(sent).toEqual([]);
  });

  test("a team's agent is nobody to invite", async () => {
    const teamId = await teamWithMember("member");
    const settings = await db.query.teamSettings.findFirst({
      columns: { botUserId: true },
      where: { teamId },
    });
    const agentEmail = await emailOf(settings?.botUserId ?? "");

    expect(
      await refusal(
        inviteToTeam({
          principal: await fx.principalOf(ownerId),
          teamId: fx.teamId,
          invitations: [{ email: agentEmail, role: "member" }],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
});

describe("what an invitation does", () => {
  test("someone in the team is not invited again; someone in the organization keeps their role", async () => {
    const owner = await fx.principalOf(ownerId);
    const memberEmail = await emailOf(memberId);
    const created = await createTeam({ principal: owner, name: "Support" });

    const already = await inviteToTeam({
      principal: owner,
      teamId: fx.teamId,
      invitations: [{ email: memberEmail, role: "admin" }],
    });
    const oneMoreTeam = await inviteToTeam({
      principal: owner,
      teamId: created.id,
      invitations: [{ email: memberEmail.toUpperCase(), role: "admin" }],
    });

    expect(already).toEqual([
      { email: memberEmail, status: "already_in_team", invitationId: null },
    ]);
    expect(oneMoreTeam[0]?.status).toBe("invited");
    // Joining one more team changes nothing else: the role they hold.
    expect(await invitationsTo(memberEmail)).toEqual([
      {
        id: expect.any(String),
        status: "pending",
        role: "member",
        teamId: created.id,
      },
    ]);
    expect(sent).toEqual([memberEmail]);
  });

  test("inviting again replaces the pending invitation, once the new one is sent", async () => {
    const owner = await fx.principalOf(ownerId);
    const address = newAddress();

    const [first] = await inviteToTeam({
      principal: owner,
      teamId: fx.teamId,
      invitations: [{ email: address, role: "member" }],
    });
    const [second] = await inviteToTeam({
      principal: owner,
      teamId: fx.teamId,
      invitations: [{ email: address, role: "member" }],
    });

    const rows = await invitationsTo(address);
    expect(rows.find((r) => r.id === first?.invitationId)?.status).toBe(
      "canceled",
    );
    expect(rows.find((r) => r.id === second?.invitationId)?.status).toBe(
      "pending",
    );
  });

  test("an email that cannot be sent withdraws its invitation, and keeps the one before", async () => {
    const owner = await fx.principalOf(ownerId);
    const address = newAddress();
    const [first] = await inviteToTeam({
      principal: owner,
      teamId: fx.teamId,
      invitations: [{ email: address, role: "member" }],
    });
    undeliverable.add(address);
    const other = newAddress();

    const outcomes = await inviteToTeam({
      principal: owner,
      teamId: fx.teamId,
      invitations: [
        { email: address, role: "member" },
        { email: other, role: "member" },
      ],
    });

    expect(outcomes.map((o) => [o.email, o.status])).toEqual([
      [address, "failed"],
      [other, "invited"],
    ]);
    const rows = await invitationsTo(address);
    const stillPending = rows
      .filter((r) => r.status === "pending")
      .map((r) => r.id);
    expect(stillPending).toEqual([first?.invitationId ?? "missing"]);
  });
});

describe("pending invitations", () => {
  test("are listed with their team and inviter, and withdrawn by whoever may invite", async () => {
    const owner = await fx.principalOf(ownerId);
    const address = newAddress();
    const [outcome] = await inviteToTeam({
      principal: owner,
      teamId: fx.teamId,
      invitations: [{ email: address, role: "member" }],
    });
    const invitationId = outcome?.invitationId ?? "";

    const pending = await listPendingInvitations({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });
    expect(pending.map((p) => [p.email, p.role, p.teamId])).toEqual([
      [address, "member", fx.teamId],
    ]);
    expect(pending[0]?.teamName).toBeString();
    expect(pending[0]?.inviterName).toBeString();

    expect(
      await refusal(
        cancelInvitation({
          principal: await fx.principalOf(memberId),
          invitationId,
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    await cancelInvitation({ principal: owner, invitationId });

    expect(
      await listPendingInvitations({ organizationId: fx.organizationId }),
    ).toEqual([]);
    expect(
      await refusal(cancelInvitation({ principal: owner, invitationId })),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });
});
