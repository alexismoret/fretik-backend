import { inArray } from "drizzle-orm";
import { requireAccess } from "../../authz/access";
import { levelRank } from "../../authz/levels";
import type { UserPrincipal } from "../../authz/principal";
import { projectLevelsOfPeople } from "../../authz/project-people";
import db from "../../db";
import { user } from "../../db/schema";
import type { ProjectPerson } from "../../schemas/projects";

/**
 * Everyone who reaches a project, with their level — whether it came from a
 * grant to them, to one of their teams or to the organization, from its team
 * while it is open, or from owning it. The share dialog lists the grants; this
 * lists the people they add up to, which is what "who is in this project"
 * means, and who can be brought into one of its chats (`use` and above).
 *
 * Read by anyone who reaches the project; a guest sees only themselves, as in
 * the share dialog.
 */
export const listProjectPeople = async (input: {
  principal: UserPrincipal;
  projectId: string;
}): Promise<ProjectPerson[]> => {
  const { principal, projectId } = input;
  await requireAccess({
    principal,
    type: "project",
    id: projectId,
    required: "view",
    notFoundMessage: "Project not found",
  });

  const levels = await projectLevelsOfPeople({
    organizationId: principal.organizationId,
    projectId,
    ...(principal.isGuest ? { userIds: [principal.userId] } : {}),
  });
  if (levels.size === 0) return [];

  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(user)
    .where(inArray(user.id, [...levels.keys()]));

  return rows
    .flatMap((row) => {
      const level = levels.get(row.userId);
      return level === undefined ? [] : [{ ...row, level }];
    })
    .sort(
      (a, b) =>
        levelRank(b.level) - levelRank(a.level) || a.name.localeCompare(b.name),
    );
};
