import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { parseOrganizationRole } from "../../authz/load-principal";
import db from "../../db";
import {
  invitation,
  member,
  organization,
  team,
  teamMember,
  user,
} from "../../db/schema";
import { personRoleSchema } from "../../schemas/members";
import type {
  InvitationToMe,
  WorkspaceMembership,
  Workspaces,
} from "../../schemas/workspaces";
import { describeInvitationItems } from "../access/guests/invitation-grants";

/** The signed-in person the answer is about. */
export interface WorkspacesOwner {
  userId: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Every organization this person belongs to, with their role and their teams
 * in each, and the invitations addressed to them that still wait.
 *
 * It answers about the person alone, before any organization is open: where
 * they stand, never anything an organization holds. The invitations are
 * matched on their address only once it is verified, so an address typed at
 * a sign-up nobody confirmed opens no one's invitations. Accepting one still
 * goes through Better Auth, which checks the address again.
 */
export const listWorkspaces = async (
  owner: WorkspacesOwner,
): Promise<Workspaces> => {
  const [memberships, invitations] = await Promise.all([
    membershipsOf(owner.userId),
    owner.emailVerified ? invitationsTo(owner.email) : [],
  ]);
  const joined = new Set(memberships.map((m) => m.organization.id));
  const items = await describeInvitationItems(
    db,
    invitations.map((row) => row.id),
  );
  return {
    memberships,
    invitations: invitations.map((row): InvitationToMe => ({
      id: row.id,
      organization: {
        id: row.organizationId,
        name: row.organizationName,
        logo: row.organizationLogo,
      },
      inviter: { name: row.inviterName, image: row.inviterImage },
      // Better Auth leaves the role empty for its default, a member.
      role: personRole(row.role ?? "member") ?? "member",
      team:
        row.teamId !== null && row.teamName !== null
          ? { id: row.teamId, name: row.teamName }
          : null,
      items: items.get(row.id) ?? [],
      expiresAt: row.expiresAt,
      alreadyMember: joined.has(row.organizationId),
    })),
  };
};

/** A stored role as a person holds it (the agents' own is not a person's). */
const personRole = (stored: string) => {
  const parsed = personRoleSchema.safeParse(parseOrganizationRole(stored));
  return parsed.success ? parsed.data : null;
};

const membershipsOf = async (
  userId: string,
): Promise<WorkspaceMembership[]> => {
  const [organizations, teams] = await Promise.all([
    db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
        role: member.role,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(sql`lower(${organization.name})`, asc(organization.id)),
    db
      .select({
        id: team.id,
        name: team.name,
        organizationId: team.organizationId,
      })
      .from(teamMember)
      .innerJoin(team, eq(team.id, teamMember.teamId))
      .where(eq(teamMember.userId, userId))
      .orderBy(sql`lower(${team.name})`, asc(team.id)),
  ]);
  return organizations.flatMap(({ role: stored, ...org }) => {
    const role = personRole(stored);
    if (role === null) return [];
    return [
      {
        organization: org,
        role,
        // A guest belongs to no team, whatever a stray row says.
        teams:
          role === "guest"
            ? []
            : teams
                .filter((t) => t.organizationId === org.id)
                .map(({ id, name }) => ({ id, name })),
      },
    ];
  });
};

const invitationsTo = (email: string) =>
  db
    .select({
      id: invitation.id,
      role: invitation.role,
      teamId: invitation.teamId,
      teamName: team.name,
      expiresAt: invitation.expiresAt,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationLogo: organization.logo,
      inviterName: user.name,
      inviterImage: user.image,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .leftJoin(
      team,
      and(
        eq(team.id, invitation.teamId),
        eq(team.organizationId, invitation.organizationId),
      ),
    )
    .where(
      and(
        eq(sql`lower(${invitation.email})`, email.trim().toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitation.createdAt));
