import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import db from "../db";
import {
  accessGrants,
  projects,
  team,
  teamMember,
  teamMemberRoles,
  teamSettings,
} from "../db/schema";
import { redis } from "../lib/redis";
import {
  type AccessLevel,
  accessLevelSchema,
  ORGANIZATION_ROLES,
  type OrganizationRole,
  organizationRoleSchema,
  type TeamRole,
  teamRoleSchema,
} from "../schemas/access";
import { resolveTeamAccessPolicy } from "../schemas/access-policy";
import {
  type GrantFact,
  teamContentLevelForRole,
  type UserPrincipal,
} from "./principal";
import { computeLevel } from "./rules";

/**
 * Loading a principal: one person in one organization, with everything the
 * rules need about them (`principal.ts`).
 *
 * Cached in Redis against the organization's ACCESS VERSION — a counter
 * bumped by every change to who belongs where (`bumpAccessVersion`): a
 * membership, a team role, an organization role, a project and its members, a
 * team's access policy. One bump invalidates every cached principal of the
 * organization at once, so no write path has to know whose cache it touched.
 * Both keys are read in one `MGET`, which keeps a cached principal to a single
 * round trip.
 *
 * The TTL is a backstop for a bump that never happened. It is also cut short
 * by the earliest expiring project grant, so a guest's access ends on time.
 */

const PRINCIPAL_TTL_SECONDS = 10 * 60;

const versionKey = (organizationId: string): string =>
  `authz:version:${organizationId}`;

const principalKey = (organizationId: string, userId: string): string =>
  `authz:principal:${organizationId}:${userId}`;

/**
 * Invalidate every cached principal of the organization. Call AFTER the change
 * commits: a reader racing the write must not refill the cache with the old
 * answer under the new version.
 */
export const bumpAccessVersion = async (
  organizationId: string,
): Promise<void> => {
  await redis.incr(versionKey(organizationId));
};

/**
 * What the cache holds: the principal with its maps as entry lists. Parsed,
 * not cast, on the way out — during a deploy two versions of this code share
 * the cache, and a shape one of them does not know is a miss, not a crash.
 */
const cachedPrincipalSchema = z.object({
  version: z.string().nullable(),
  userId: z.string(),
  organizationId: z.string(),
  orgRole: organizationRoleSchema,
  teamRoles: z.array(z.tuple([z.string(), teamRoleSchema])),
  teamContentLevels: z.array(z.tuple([z.string(), accessLevelSchema])),
  projectLevels: z.array(z.tuple([z.string(), accessLevelSchema])),
});
type CachedPrincipal = z.infer<typeof cachedPrincipalSchema>;

const readCached = (json: string | null): CachedPrincipal | null => {
  if (json === null) return null;
  try {
    const parsed = cachedPrincipalSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const toPrincipal = (cached: CachedPrincipal): UserPrincipal => ({
  kind: "user",
  userId: cached.userId,
  organizationId: cached.organizationId,
  orgRole: cached.orgRole,
  isOrgAdmin: cached.orgRole === "owner" || cached.orgRole === "admin",
  isGuest: cached.orgRole === "guest",
  teamRoles: new Map(cached.teamRoles),
  teamContentLevels: new Map(cached.teamContentLevels),
  projectLevels: new Map(cached.projectLevels),
});

const isOrganizationRole = (role: string): role is OrganizationRole =>
  (ORGANIZATION_ROLES as readonly string[]).includes(role);

/**
 * Better Auth stores several roles as one comma-separated string. The engine
 * reads the strongest, so "member,admin" is an admin — and an unknown role
 * reads as a guest, the role that gives the least.
 */
const ROLE_STRENGTH: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "member",
  "bot",
  "guest",
];
const parseOrganizationRole = (stored: string): OrganizationRole => {
  const roles = stored
    .split(",")
    .map((role) => role.trim())
    .filter(isOrganizationRole);
  return ROLE_STRENGTH.find((role) => roles.includes(role)) ?? "guest";
};

const loadFromDatabase = async (
  organizationId: string,
  userId: string,
): Promise<{ principal: CachedPrincipal; expiresAt: Date | null } | null> => {
  const membership = await db.query.member.findFirst({
    columns: { role: true },
    where: { organizationId, userId },
  });
  if (!membership) return null;
  const orgRole = parseOrganizationRole(membership.role);

  // The person's teams in this organization, with the role row when there is
  // one — none means `member` (see `db/schema/access.ts`).
  const teams = await db
    .select({
      teamId: teamMember.teamId,
      role: teamMemberRoles.role,
      policy: teamSettings.accessPolicy,
    })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .leftJoin(teamMemberRoles, eq(teamMemberRoles.teamMemberId, teamMember.id))
    .leftJoin(teamSettings, eq(teamSettings.teamId, teamMember.teamId))
    .where(
      and(
        eq(teamMember.userId, userId),
        eq(team.organizationId, organizationId),
      ),
    );

  // A guest belongs to no team, whatever a stray row says: guests only see
  // what is shared with them.
  const teamRoles: [string, TeamRole][] =
    orgRole === "guest"
      ? []
      : teams.map((row) => [row.teamId, row.role ?? "member"]);
  const teamContentLevels: [string, AccessLevel][] =
    orgRole === "guest"
      ? []
      : teams.map((row) => [
          row.teamId,
          teamContentLevelForRole(
            row.role ?? "member",
            resolveTeamAccessPolicy(row.policy),
          ),
        ]);

  const { levels: projectLevels, expiresAt } = await loadProjectLevels({
    organizationId,
    userId,
    orgRole,
    teamRoles: new Map(teamRoles),
  });

  return {
    principal: {
      version: null,
      userId,
      organizationId,
      orgRole,
      teamRoles,
      teamContentLevels,
      projectLevels,
    },
    expiresAt,
  };
};

/**
 * The person's level on every project they reach — through a grant to them,
 * to one of their teams or to the organization, through ownership, or through
 * their team when the project is open to it. Computed with the same rules as
 * any resource (`computeLevel`), so a project's level here and on its own page
 * cannot disagree.
 */
const loadProjectLevels = async (input: {
  organizationId: string;
  userId: string;
  orgRole: OrganizationRole;
  teamRoles: ReadonlyMap<string, TeamRole>;
}): Promise<{ levels: [string, AccessLevel][]; expiresAt: Date | null }> => {
  const { organizationId, userId, orgRole, teamRoles } = input;
  const teamIds = [...teamRoles.keys()];
  const isGuest = orgRole === "guest";
  const now = new Date();

  const grantRows = await db
    .select({
      projectId: accessGrants.resourceId,
      principalType: accessGrants.principalType,
      principalId: accessGrants.principalId,
      level: accessGrants.level,
      expiresAt: accessGrants.expiresAt,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.organizationId, organizationId),
        eq(accessGrants.resourceType, "project"),
        or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, now)),
        or(
          and(
            eq(accessGrants.principalType, "user"),
            eq(accessGrants.principalId, userId),
          ),
          teamIds.length > 0
            ? and(
                eq(accessGrants.principalType, "team"),
                inArray(accessGrants.principalId, teamIds),
              )
            : undefined,
          isGuest
            ? undefined
            : and(
                eq(accessGrants.principalType, "organization"),
                eq(accessGrants.principalId, organizationId),
              ),
        ),
      ),
    );

  const grantsByProject = new Map<string, GrantFact[]>();
  let expiresAt: Date | null = null;
  for (const row of grantRows) {
    if (row.principalType === "invitation") continue;
    const list = grantsByProject.get(row.projectId) ?? [];
    list.push({
      principalType: row.principalType,
      principalId: row.principalId,
      level: row.level,
    });
    grantsByProject.set(row.projectId, list);
    if (row.expiresAt && (expiresAt === null || row.expiresAt < expiresAt)) {
      expiresAt = row.expiresAt;
    }
  }

  // The candidate projects: granted ones, owned ones, and those of the
  // person's teams (which open to the team unless restricted).
  const candidates = await db
    .select({
      id: projects.id,
      teamId: projects.teamId,
      ownerUserId: projects.ownerUserId,
      restricted: projects.accessRestricted,
    })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        or(
          grantsByProject.size > 0
            ? inArray(projects.id, [...grantsByProject.keys()])
            : undefined,
          eq(projects.ownerUserId, userId),
          teamIds.length > 0 ? inArray(projects.teamId, teamIds) : undefined,
        ),
      ),
    );

  // Computed without project levels of its own: a project is never granted to
  // a project, so `computeLevel` does not read them for a project node.
  const bare: UserPrincipal = {
    kind: "user",
    userId,
    organizationId,
    orgRole,
    isOrgAdmin: orgRole === "owner" || orgRole === "admin",
    isGuest,
    teamRoles,
    teamContentLevels: new Map(),
    projectLevels: new Map(),
  };
  const levels: [string, AccessLevel][] = [];
  for (const project of candidates) {
    const level = computeLevel(bare, {
      type: "project",
      id: project.id,
      organizationId,
      teamId: project.teamId,
      projectId: null,
      ownerUserId: project.ownerUserId,
      restricted: project.restricted,
      grants: grantsByProject.get(project.id) ?? [],
      parent: null,
    });
    if (level !== null) levels.push([project.id, level]);
  }
  return { levels, expiresAt };
};

/**
 * The person as the engine sees them in this organization, or null when they
 * are not a member of it.
 */
export const loadPrincipal = async (input: {
  organizationId: string;
  userId: string;
}): Promise<UserPrincipal | null> => {
  const { organizationId, userId } = input;
  const [version, cachedJson] = await redis.mget(
    versionKey(organizationId),
    principalKey(organizationId, userId),
  );
  const cached = readCached(cachedJson ?? null);
  if (cached && cached.version === (version ?? null)) {
    return toPrincipal(cached);
  }

  const loaded = await loadFromDatabase(organizationId, userId);
  if (!loaded) return null;

  const fresh: CachedPrincipal = {
    ...loaded.principal,
    version: version ?? null,
  };
  const untilExpiry =
    loaded.expiresAt === null
      ? PRINCIPAL_TTL_SECONDS
      : Math.max(
          1,
          Math.floor((loaded.expiresAt.getTime() - Date.now()) / 1000),
        );
  await redis.set(
    principalKey(organizationId, userId),
    JSON.stringify(fresh),
    "EX",
    Math.min(PRINCIPAL_TTL_SECONDS, untilExpiry),
  );
  return toPrincipal(fresh);
};
