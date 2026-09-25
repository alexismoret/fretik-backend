import { and, eq, inArray } from "drizzle-orm";
import db, { type Executor } from "../db";
import { member, teamMember, teamMemberRoles } from "../db/schema";
import type { AccessLevel, TeamRole } from "../schemas/access";
import { atLeast } from "./levels";
import { parseOrganizationRole } from "./load-principal";
import type { UserPrincipal } from "./principal";
import { projectAdapter } from "./resources/structure";
import { computeLevel } from "./rules";

/**
 * The level each person of the organization has on ONE project, by the
 * engine's own rules — for the questions asked about many people at once:
 * who may take part in a chat of the project, who is in it at all.
 *
 * A project's level reads, of a person, only their organization role (a guest
 * gets nothing from an organization grant) and their roles in the teams the
 * project names: its own, which it is open to, and the teams it is shared
 * with. A project is never given to a project. So each person is decided with
 * exactly those facts by `computeLevel`, and gets the answer their own
 * principal would. The team's agent is not a person and is never listed.
 */
export const projectLevelsOfPeople = async (input: {
  organizationId: string;
  projectId: string;
  /** Only these people; everyone in the organization when omitted. */
  userIds?: readonly string[];
  executor?: Executor;
}): Promise<Map<string, AccessLevel>> => {
  const executor = input.executor ?? db;
  const levels = new Map<string, AccessLevel>();
  if (input.userIds?.length === 0) return levels;

  const node = (
    await projectAdapter.loadNodes([input.projectId], executor)
  ).get(input.projectId);
  if (!node || node.organizationId !== input.organizationId) return levels;

  const teamIds = [
    ...new Set([
      ...(node.teamId === null ? [] : [node.teamId]),
      ...node.grants.flatMap((grant) =>
        grant.principalType === "team" ? [grant.principalId] : [],
      ),
    ]),
  ];
  const onlyThese =
    input.userIds === undefined
      ? []
      : [inArray(member.userId, [...input.userIds])];

  const [people, seats] = await Promise.all([
    executor
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(
        and(eq(member.organizationId, input.organizationId), ...onlyThese),
      ),
    teamIds.length === 0
      ? []
      : executor
          .select({
            userId: teamMember.userId,
            teamId: teamMember.teamId,
            role: teamMemberRoles.role,
          })
          .from(teamMember)
          .leftJoin(
            teamMemberRoles,
            eq(teamMemberRoles.teamMemberId, teamMember.id),
          )
          .where(
            and(
              inArray(teamMember.teamId, teamIds),
              ...(input.userIds === undefined
                ? []
                : [inArray(teamMember.userId, [...input.userIds])]),
            ),
          ),
  ]);

  const rolesOf = new Map<string, Map<string, TeamRole>>();
  for (const seat of seats) {
    const roles = rolesOf.get(seat.userId) ?? new Map<string, TeamRole>();
    // No role row means `member` (`db/schema/access.ts`).
    roles.set(seat.teamId, seat.role ?? "member");
    rolesOf.set(seat.userId, roles);
  }

  for (const person of people) {
    const orgRole = parseOrganizationRole(person.role);
    if (orgRole === "bot") continue;
    const isGuest = orgRole === "guest";
    const principal: UserPrincipal = {
      kind: "user",
      userId: person.userId,
      organizationId: input.organizationId,
      orgRole,
      isOrgAdmin: orgRole === "owner" || orgRole === "admin",
      isGuest,
      // A guest belongs to no team, whatever a stray row says.
      teamRoles: isGuest
        ? new Map()
        : (rolesOf.get(person.userId) ?? new Map()),
      teamContentLevels: new Map(),
      projectLevels: new Map(),
    };
    const level = computeLevel(principal, node);
    if (level !== null) levels.set(person.userId, level);
  }
  return levels;
};

/**
 * The people who take part in a project (`use` and above): who may be seated
 * in one of its chats, and who reads what its assistant writes there.
 */
export const projectParticipants = async (input: {
  organizationId: string;
  projectId: string;
  userIds?: readonly string[];
  executor?: Executor;
}): Promise<Set<string>> => {
  const levels = await projectLevelsOfPeople(input);
  return new Set(
    [...levels].flatMap(([userId, level]) =>
      atLeast(level, "use") ? [userId] : [],
    ),
  );
};
