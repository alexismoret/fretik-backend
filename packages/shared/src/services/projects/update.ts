import { eq } from "drizzle-orm";
import { requireAccess } from "../../authz/access";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { projects } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import type { ProjectDetail, UpdateProjectInput } from "../../schemas/projects";
import { readProjectDetail } from "./read";

/**
 * Change a project: its instructions for the assistant take `edit`, like
 * the rest of what its people work on together; its name, description, icon
 * and color are its settings, and take `full`. An archived project changes
 * nothing until it is restored.
 */
export const updateProject = async (input: {
  principal: UserPrincipal;
  projectId: string;
  patch: UpdateProjectInput;
}): Promise<ProjectDetail> => {
  const { principal, projectId, patch } = input;
  const settings =
    patch.name !== undefined ||
    patch.description !== undefined ||
    patch.icon !== undefined ||
    patch.color !== undefined;
  const { level } = await requireAccess({
    principal,
    type: "project",
    id: projectId,
    required: settings ? "full" : "edit",
    notFoundMessage: "Project not found",
  });

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (current?.archivedAt != null) {
      throwHttpError(409, {
        code: ERROR_CODES.PROJECT_ARCHIVED,
        message: "This project is archived. Restore it to change it.",
      });
    }
    await tx
      .update(projects)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
        ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(patch.instructions === undefined
          ? {}
          : { instructions: patch.instructions }),
      })
      .where(eq(projects.id, projectId));
  });

  return readProjectDetail(projectId, level);
};
