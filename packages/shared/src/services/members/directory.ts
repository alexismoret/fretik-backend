import { and, eq } from "drizzle-orm";
import { parseOrganizationRole } from "../../authz/load-principal";
import db from "../../db";
import {
  member,
  team,
  teamMember,
  teamMemberRoles,
  user,
} from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { OrganizationMember } from "../../schemas/members";

/**
 * The organization's people, with their teams and their role in each — the
 * Members page, and every picker that adds someone to a team.
 *
 * Not paged and not capped. Better Auth's `listMembers` stops at 100 rows by
 * default, counting the team agents' accounts; a directory that silently
 * drops whoever comes after them makes those people impossible to find, add
 * or promote. The agents' accounts themselves are left out: they are not
 * people.
 */

const readMembers = async (
  organizationId: string,
  userId?: string,
): Promise<OrganizationMember[]> => {
  const people = await db
    .select({
      userId: member.userId,
      role: member.role,
      joinedAt: member.createdAt,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        userId === undefined ? undefined : eq(member.userId, userId),
      ),
    );

  const seats = await db
    .select({
      userId: teamMember.userId,
      teamId: team.id,
      name: team.name,
      role: teamMemberRoles.role,
    })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .leftJoin(teamMemberRoles, eq(teamMemberRoles.teamMemberId, teamMember.id))
    .where(
      and(
        eq(team.organizationId, organizationId),
        userId === undefined ? undefined : eq(teamMember.userId, userId),
      ),
    );

  const teamsOf = new Map<string, OrganizationMember["teams"]>();
  for (const seat of seats) {
    const teams = teamsOf.get(seat.userId) ?? [];
    // No role row is a member: every seat predating roles is one.
    teams.push({
      teamId: seat.teamId,
      name: seat.name,
      role: seat.role ?? "member",
    });
    teamsOf.set(seat.userId, teams);
  }

  const members: OrganizationMember[] = [];
  for (const person of people) {
    const role = parseOrganizationRole(person.role);
    if (role === "bot") continue;
    members.push({
      userId: person.userId,
      name: person.name,
      email: person.email,
      image: person.image,
      role,
      joinedAt: person.joinedAt,
      teams: (teamsOf.get(person.userId) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    });
  }
  return members.sort((a, b) => a.name.localeCompare(b.name));
};

export const listOrganizationMembers = (
  organizationId: string,
): Promise<OrganizationMember[]> => readMembers(organizationId);

/**
 * One person of the organization, or 404 — someone of another organization,
 * or a team agent's account, answers like no one.
 */
export const getOrganizationMember = async (
  organizationId: string,
  userId: string,
): Promise<OrganizationMember> => {
  const [found] = await readMembers(organizationId, userId);
  if (!found) return throwHttpError(404, notFound("Member not found"));
  return found;
};
