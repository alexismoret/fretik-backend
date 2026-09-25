import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { requireAccess } from "../../authz/access";
import type { UserPrincipal } from "../../authz/principal";
import { throwNotVisible } from "../../authz/refusals";
import db from "../../db";
import { projects, team, user } from "../../db/schema";
import type { AccessLevel } from "../../schemas/access";
import type { ProjectDetail, ProjectSummary } from "../../schemas/projects";

/**
 * Reading projects: the ones a person reaches, and one of them in full.
 *
 * Which projects a person reaches, and at what level, is already part of
 * their principal (`principal.projectLevels`, computed by the engine's rules
 * and invalidated with every change to a project's members), so a list costs
 * one query on the ids it names.
 */

const summaryColumns = {
  id: projects.id,
  teamId: projects.teamId,
  teamName: team.name,
  name: projects.name,
  description: projects.description,
  icon: projects.icon,
  color: projects.color,
  restricted: projects.accessRestricted,
  archivedAt: projects.archivedAt,
  ownerUserId: projects.ownerUserId,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

/** The projects the person reaches, by name — one team's, or every team's. */
export const listProjects = async (input: {
  principal: UserPrincipal;
  teamId?: string;
  includeArchived?: boolean;
}): Promise<ProjectSummary[]> => {
  const { principal } = input;
  const ids = [...principal.projectLevels.keys()];
  if (ids.length === 0) return [];

  const rows = await db
    .select(summaryColumns)
    .from(projects)
    .innerJoin(team, eq(team.id, projects.teamId))
    .where(
      and(
        inArray(projects.id, ids),
        eq(projects.organizationId, principal.organizationId),
        input.teamId === undefined
          ? undefined
          : eq(projects.teamId, input.teamId),
        input.includeArchived ? undefined : isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(projects.name));

  return rows.flatMap((row) => {
    const level = principal.projectLevels.get(row.id);
    return level === undefined ? [] : [{ ...row, level }];
  });
};

/** One project, in full, for anyone who reaches it (`view`). */
export const getProject = async (input: {
  principal: UserPrincipal;
  projectId: string;
}): Promise<ProjectDetail> => {
  const { level } = await requireAccess({
    principal: input.principal,
    type: "project",
    id: input.projectId,
    required: "view",
    notFoundMessage: "Project not found",
  });
  return readProjectDetail(input.projectId, level);
};

/** The project's detail, for someone already known to reach it at `level`. */
export const readProjectDetail = async (
  projectId: string,
  level: AccessLevel,
): Promise<ProjectDetail> => {
  const [row] = await db
    .select({
      ...summaryColumns,
      instructions: projects.instructions,
      ownerName: user.name,
      ownerEmail: user.email,
      ownerImage: user.image,
    })
    .from(projects)
    .innerJoin(team, eq(team.id, projects.teamId))
    .leftJoin(user, eq(user.id, projects.ownerUserId))
    .where(eq(projects.id, projectId));
  // Reached a moment ago, deleted since: gone, like any vanished item.
  if (!row) return throwNotVisible("Project not found");
  const { ownerName, ownerEmail, ownerImage, ...rest } = row;
  return {
    ...rest,
    level,
    owner:
      row.ownerUserId !== null && ownerName !== null && ownerEmail !== null
        ? {
            userId: row.ownerUserId,
            name: ownerName,
            email: ownerEmail,
            image: ownerImage,
          }
        : null,
  };
};

/**
 * A project's id and name, to start a path with — for an item already known
 * to be visible, whose project is named, never listed.
 */
export const readProjectName = async (
  projectId: string,
): Promise<{ id: string; name: string } | null> => {
  const [row] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row ?? null;
};
