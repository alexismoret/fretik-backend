import { and, desc, eq, gt } from "drizzle-orm";
import { parseOrganizationRole } from "../../authz/load-principal";
import db from "../../db";
import { invitation, team, user } from "../../db/schema";
import type { PendingInvitation } from "../../schemas/members";

/**
 * The invitations still waiting for an answer — the whole organization's for
 * its admins (the Members page), one team's for whoever may invite into it
 * (the team's page). The route decides which a caller may ask for.
 *
 * An expired invitation is not pending, whatever its status says: Better Auth
 * never moves one out of `pending`, it only refuses to accept it.
 */
export const listPendingInvitations = async (input: {
  organizationId: string;
  teamId?: string;
}): Promise<PendingInvitation[]> => {
  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      teamId: invitation.teamId,
      teamName: team.name,
      inviterName: user.name,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    })
    .from(invitation)
    .leftJoin(team, eq(team.id, invitation.teamId))
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(
      and(
        eq(invitation.organizationId, input.organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
        input.teamId === undefined
          ? undefined
          : eq(invitation.teamId, input.teamId),
      ),
    )
    .orderBy(desc(invitation.createdAt));

  const invitations: PendingInvitation[] = [];
  for (const row of rows) {
    // No role is Better Auth's default: a member.
    const role = parseOrganizationRole(row.role ?? "member");
    if (role === "bot") continue;
    invitations.push({ ...row, role });
  }
  return invitations;
};
