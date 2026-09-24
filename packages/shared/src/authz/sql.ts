import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { AccessLevel, AccessResourceType } from "../schemas/access";
import { atLeast } from "./levels";
import { projectContentLevel, type UserPrincipal } from "./principal";

/**
 * The access rules as SQL, for LISTS.
 *
 * `rules.ts` decides one resource at a time; a list cannot afford that, so it
 * filters with the predicates below instead. They say the same thing — the
 * owner, the grants, the container unless restricted — with everything about
 * the person precomputed into arrays (the teams whose content gives them at
 * least the level, the projects likewise), so each row costs at most one
 * index probe into `access_grants`. The integration suite checks both against
 * the same fixtures (`tests/integration/authz/list-agreement.test.ts`); a rule
 * changed in one place and not the other fails there.
 *
 * Each predicate is an OR of arms, cheapest first, so Postgres stops at the
 * first that holds: ownership and the container are plain column tests; the
 * grants are an `EXISTS` on the grants' unique index.
 */

const uuidArray = (ids: readonly string[]): SQL =>
  sql`${sql.param([...ids])}::uuid[]`;

/** The teams whose own content gives the person at least `level`. */
export const teamsReaching = (
  principal: UserPrincipal,
  level: AccessLevel,
): string[] =>
  [...principal.teamContentLevels]
    .filter(([, teamLevel]) => atLeast(teamLevel, level))
    .map(([teamId]) => teamId);

/** The projects whose open content gives the person at least `level`. */
export const projectsReaching = (
  principal: UserPrincipal,
  level: AccessLevel,
): string[] =>
  [...principal.projectLevels]
    .filter(([, projectLevel]) =>
      atLeast(projectContentLevel(projectLevel), level),
    )
    .map(([projectId]) => projectId);

/**
 * The grant principals that give the person at least `level` — mirroring
 * `levelFromGrants`: a team viewer and a project viewer or participant only
 * ever get `view` from a grant to their group.
 */
const grantPrincipalMatch = (
  principal: UserPrincipal,
  level: AccessLevel,
): SQL => {
  const teams = [...principal.teamRoles]
    .filter(([, role]) => level === "view" || role !== "viewer")
    .map(([teamId]) => teamId);
  const projects = [...principal.projectLevels]
    .filter(
      ([, projectLevel]) =>
        level === "view" || (projectLevel !== "view" && projectLevel !== "use"),
    )
    .map(([projectId]) => projectId);

  const arms: SQL[] = [
    sql`(g.principal_type = 'user' AND g.principal_id = ${principal.userId})`,
  ];
  if (teams.length > 0) {
    arms.push(
      sql`(g.principal_type = 'team' AND g.principal_id = ANY(${uuidArray(teams)}))`,
    );
  }
  if (projects.length > 0) {
    arms.push(
      sql`(g.principal_type = 'project' AND g.principal_id = ANY(${uuidArray(projects)}))`,
    );
  }
  if (!principal.isGuest) {
    arms.push(
      sql`(g.principal_type = 'organization' AND g.principal_id = ${principal.organizationId})`,
    );
  }
  return sql`(${sql.join(arms, sql` OR `)})`;
};

/** An explicit grant on the row gives the person at least `level`. */
export const grantArm = (input: {
  principal: UserPrincipal;
  level: AccessLevel;
  resourceType: AccessResourceType;
  resourceId: AnyColumn | SQL;
}): SQL => sql`EXISTS (
  SELECT 1 FROM access_grants g
  WHERE g.resource_type = ${input.resourceType}::access_resource_type
    AND g.resource_id = ${input.resourceId}
    AND g.level >= ${input.level}::access_level
    AND g.principal_type <> 'invitation'
    AND (g.expires_at IS NULL OR g.expires_at > now())
    AND ${grantPrincipalMatch(input.principal, input.level)}
)`;

/**
 * The container gives the person at least `level`: the project when the row
 * has one, else the team. Callers AND this with "not restricted".
 */
export const containerArm = (input: {
  principal: UserPrincipal;
  level: AccessLevel;
  teamId: AnyColumn | SQL;
  projectId: AnyColumn | SQL;
}): SQL => {
  const teams = teamsReaching(input.principal, input.level);
  const projects = projectsReaching(input.principal, input.level);
  const arms: SQL[] = [];
  if (teams.length > 0) {
    arms.push(
      sql`(${input.projectId} IS NULL AND ${input.teamId} = ANY(${uuidArray(teams)}))`,
    );
  }
  if (projects.length > 0) {
    arms.push(sql`${input.projectId} = ANY(${uuidArray(projects)})`);
  }
  return arms.length === 0 ? sql`false` : sql`(${sql.join(arms, sql` OR `)})`;
};

/**
 * The columns a flat resource keeps its access facts in. `restricted` and
 * `owner` are expressions because pages and workflows read two columns each
 * (see `resources/content.ts`).
 */
export interface FlatAccessColumns {
  readonly id: AnyColumn | SQL;
  readonly organizationId: AnyColumn | SQL;
  readonly teamId: AnyColumn | SQL;
  readonly projectId: AnyColumn | SQL;
  readonly owner: AnyColumn | SQL;
  readonly restricted: AnyColumn | SQL;
}

/**
 * The rows of a flat resource type the person reaches at `level`.
 *
 * `restrictedCeiling` is the workflow rule of `rules.ts`: a restricted row is
 * capped at `view` for everyone but its owner, so above `view` only the owner
 * arm can match it.
 */
export const flatAccessible = (input: {
  principal: UserPrincipal;
  level: AccessLevel;
  resourceType: AccessResourceType;
  columns: FlatAccessColumns;
  restrictedCeiling?: AccessLevel;
}): SQL => {
  const { principal, level, columns } = input;
  const grants = grantArm({
    principal,
    level,
    resourceType: input.resourceType,
    resourceId: columns.id,
  });
  const cappedGrants =
    input.restrictedCeiling !== undefined &&
    !atLeast(input.restrictedCeiling, level)
      ? sql`(NOT ${columns.restricted} AND ${grants})`
      : grants;
  return sql`(
    ${columns.organizationId} = ${principal.organizationId}
    AND (
      ${columns.owner} = ${principal.userId}
      OR (NOT ${columns.restricted} AND ${containerArm({
        principal,
        level,
        teamId: columns.teamId,
        projectId: columns.projectId,
      })})
      OR ${cappedGrants}
    )
  )`;
};
