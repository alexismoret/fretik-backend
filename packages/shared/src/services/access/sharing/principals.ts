import { and, eq, inArray, sql } from "drizzle-orm";
import { parseOrganizationRole } from "../../../authz/load-principal";
import db from "../../../db";
import {
  member,
  projects,
  team,
  teamMember,
  teamSettings,
  user,
} from "../../../db/schema";
import type { ShareablePrincipalType } from "../../../schemas/access";

/**
 * The principals of the share dialog — people, teams, projects, the whole
 * organization — as the engine's grants name them (a type and an id), made
 * readable, and checked to belong to the organization before anything is
 * given to them.
 */

export interface PrincipalRef {
  readonly type: ShareablePrincipalType;
  readonly id: string;
}

/** A principal as the dialog shows it. */
export interface DescribedPrincipal extends PrincipalRef {
  readonly name: string;
  readonly email: string | null;
  readonly image: string | null;
  /** A group's people; null for a person. */
  readonly memberCount: number | null;
  /**
   * A person from outside the organization, who sees only what is shared
   * with them — and is given it on a guest's terms (`authz/guests.ts`).
   */
  readonly guest: boolean;
}

/** A principal someone picked, checked to be of the organization. */
export interface Grantee extends DescribedPrincipal {
  /**
   * The teams this principal is, or is in, for "beyond the resource's team":
   * a person's teams, a team itself, a project's team. Empty for the
   * organization, which has its own policy.
   */
  readonly teamIds: ReadonlySet<string>;
}

const keyOf = (ref: PrincipalRef): string => `${ref.type}:${ref.id}`;

const idsOf = (refs: readonly PrincipalRef[], type: ShareablePrincipalType) => [
  ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
];

/** People of the organization, its guests included; its agents are not people. */
const loadPeople = async (organizationId: string, ids: string[]) => {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, ids),
      ),
    );
  const seats = await db
    .select({ userId: teamMember.userId, teamId: teamMember.teamId })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(
      and(
        eq(team.organizationId, organizationId),
        inArray(teamMember.userId, ids),
      ),
    );
  const teamsOf = new Map<string, Set<string>>();
  for (const seat of seats) {
    const teams = teamsOf.get(seat.userId) ?? new Set<string>();
    teams.add(seat.teamId);
    teamsOf.set(seat.userId, teams);
  }
  return rows.flatMap((row): Grantee[] => {
    const role = parseOrganizationRole(row.role);
    if (role === "bot") return [];
    const guest = role === "guest";
    return [
      {
        type: "user",
        id: row.id,
        name: row.name,
        email: row.email,
        image: row.image,
        memberCount: null,
        guest,
        // A guest belongs to no team, whatever a stray row says.
        teamIds: guest ? new Set() : (teamsOf.get(row.id) ?? new Set()),
      },
    ];
  });
};

/** Teams of the organization, with their people (the team's agent is not one). */
const loadTeams = async (organizationId: string, ids: string[]) => {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: team.id,
      name: team.name,
      memberCount:
        sql<number>`count(${teamMember.userId}) filter (where ${teamMember.userId} is distinct from ${teamSettings.botUserId})`.mapWith(
          Number,
        ),
    })
    .from(team)
    .leftJoin(teamSettings, eq(teamSettings.teamId, team.id))
    .leftJoin(teamMember, eq(teamMember.teamId, team.id))
    .where(and(eq(team.organizationId, organizationId), inArray(team.id, ids)))
    .groupBy(team.id, teamSettings.botUserId);
  return rows.map((row): Grantee => ({
    type: "team",
    id: row.id,
    name: row.name,
    email: null,
    image: null,
    memberCount: row.memberCount,
    guest: false,
    teamIds: new Set([row.id]),
  }));
};

const loadProjects = async (organizationId: string, ids: string[]) => {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: projects.id, name: projects.name, teamId: projects.teamId })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        inArray(projects.id, ids),
      ),
    );
  return rows.map((row): Grantee => ({
    type: "project",
    id: row.id,
    name: row.name,
    email: null,
    image: null,
    memberCount: null,
    guest: false,
    teamIds: new Set([row.teamId]),
  }));
};

/** The organization itself: everyone in it, its agents and guests aside. */
const loadOrganization = async (
  organizationId: string,
  ids: string[],
): Promise<Grantee[]> => {
  if (!ids.includes(organizationId)) return [];
  const [org, roles] = await Promise.all([
    db.query.organization.findFirst({
      columns: { name: true },
      where: { id: organizationId },
    }),
    db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.organizationId, organizationId)),
  ]);
  if (!org) return [];
  const people = roles.filter(({ role }) => {
    const parsed = parseOrganizationRole(role);
    return parsed !== "bot" && parsed !== "guest";
  }).length;
  return [
    {
      type: "organization",
      id: organizationId,
      name: org.name,
      email: null,
      image: null,
      memberCount: people,
      guest: false,
      teamIds: new Set(),
    },
  ];
};

/**
 * The principals of `refs` that exist in the organization, keyed by
 * `type:id`. One that does not — another organization's team, a stranger, an
 * agent's account — is simply absent, and the caller refuses it. A guest is
 * present, flagged: what they may be given is the sharing service's call.
 */
export const resolvePrincipals = async (
  organizationId: string,
  refs: readonly PrincipalRef[],
): Promise<Map<string, Grantee>> => {
  const groups = await Promise.all([
    loadPeople(organizationId, idsOf(refs, "user")),
    loadTeams(organizationId, idsOf(refs, "team")),
    loadProjects(organizationId, idsOf(refs, "project")),
    loadOrganization(organizationId, idsOf(refs, "organization")),
  ]);
  return new Map(groups.flat().map((grantee) => [keyOf(grantee), grantee]));
};

/** Look a resolved principal up by its reference. */
export const principalKey = keyOf;

/**
 * The name a principal goes by, for the journal; null when it is no longer
 * part of the organization.
 */
export const principalName = async (
  organizationId: string,
  ref: PrincipalRef,
): Promise<string | null> =>
  (await resolvePrincipals(organizationId, [ref])).get(keyOf(ref))?.name ??
  null;
