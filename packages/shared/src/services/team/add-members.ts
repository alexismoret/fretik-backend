import { and, eq, inArray } from "drizzle-orm";
import { requireCapability } from "../../authz/gates";
import { parseOrganizationRole } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { member, teamMemberRoles, user } from "../../db/schema";
import { MAX_MEMBERS_PER_TEAM } from "../../lib/auth-constants";
import { onMembershipChanged } from "../../lib/auth-membership";
import { badRequest, throwHttpError } from "../../lib/errors";
import { organizationAdapter } from "../../lib/org-adapter";
import type { TeamRole } from "../../schemas/access";
import { ERROR_CODES } from "../../schemas/errors";
import type { TeamMemberEntry } from "../../schemas/teams";
import { recordAccessEvent } from "../access/record-event";
import { findOrganizationTeam, findTeamSeat } from "./find";
import { listTeamRoster } from "./roster";

/**
 * Bring people of the organization into a team, with one role. The team's
 * leads decide, and the organization's admins (`team.members.manage`).
 *
 * Only members of the organization join a team: a guest is shared items, not
 * teams, and an agent user belongs to its own team only. Someone already in
 * the team keeps the role they have — adding is not how a role changes.
 *
 * Sequential on purpose: when the team's seat limit is reached, the people
 * after that point must not join, and the refusal says so; the ones before it
 * did join, and the roster returned shows them.
 */
export const addTeamMembers = async (input: {
  principal: UserPrincipal;
  teamId: string;
  userIds: readonly string[];
  role: TeamRole;
}): Promise<TeamMemberEntry[]> => {
  const { principal } = input;
  const found = await findOrganizationTeam(principal, input.teamId);
  await requireCapability({
    principal,
    capability: "team.members.manage",
    teamId: found.id,
  });

  const ids = [...new Set(input.userIds)];
  const people = await db
    .select({ userId: member.userId, role: member.role, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, principal.organizationId),
        inArray(member.userId, ids),
      ),
    );
  const eligible = people.filter((person) => {
    const role = parseOrganizationRole(person.role);
    return role !== "guest" && role !== "bot";
  });
  if (eligible.length !== ids.length) {
    return throwHttpError(
      400,
      badRequest("Only members of the organization can join a team."),
    );
  }

  const adapter = await organizationAdapter();
  let added = 0;
  try {
    for (const person of eligible) {
      // eslint-disable-next-line no-await-in-loop -- stops at the seat limit
      if (await findTeamSeat(found.id, person.userId)) continue;
      // eslint-disable-next-line no-await-in-loop -- stops at the seat limit
      const result = await adapter.addTeamMemberWithLimit({
        teamId: found.id,
        userId: person.userId,
        maximumMembersPerTeam: MAX_MEMBERS_PER_TEAM,
      });
      if (result.status === "limitReached") {
        return throwHttpError(409, {
          code: ERROR_CODES.TEAM_MEMBER_LIMIT_REACHED,
          message: `The team is full (${MAX_MEMBERS_PER_TEAM.toString()} people).`,
        });
      }
      added += 1;
      // eslint-disable-next-line no-await-in-loop -- one person at a time
      await db.transaction(async (tx) => {
        if (input.role !== "member") {
          await tx
            .insert(teamMemberRoles)
            .values({
              teamMemberId: result.member.id,
              teamId: found.id,
              userId: person.userId,
              role: input.role,
              updatedByUserId: principal.userId,
            })
            .onConflictDoNothing();
        }
        await recordAccessEvent({
          executor: tx,
          organizationId: principal.organizationId,
          actorUserId: principal.userId,
          action: "team_member.added",
          principal: { type: "user", id: person.userId },
          metadata: {
            teamId: found.id,
            teamName: found.name,
            userName: person.name,
            role: input.role,
          },
        });
      });
    }
  } finally {
    // Whoever joined before a refusal did join: every cached principal of the
    // organization learns of them either way.
    if (added > 0) await onMembershipChanged(principal.organizationId);
  }
  return listTeamRoster(found.id);
};
