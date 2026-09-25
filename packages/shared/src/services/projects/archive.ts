import { eq } from "drizzle-orm";
import { requireAccess } from "../../authz/access";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { projects } from "../../db/schema";
import type { ProjectDetail } from "../../schemas/projects";
import { recordAccessEvent } from "../access/record-event";
import { readProjectDetail } from "./read";

/**
 * Archive a project, or restore it — full access. Archived, it keeps
 * everything it holds and who reaches it, reads as before, and takes nothing
 * new; the lists leave it out unless asked. Archiving twice, or restoring a
 * project that is not archived, changes nothing.
 */
export const setProjectArchived = async (input: {
  principal: UserPrincipal;
  projectId: string;
  archived: boolean;
}): Promise<ProjectDetail> => {
  const { principal, projectId, archived } = input;
  const { node, level } = await requireAccess({
    principal,
    type: "project",
    id: projectId,
    required: "full",
    notFoundMessage: "Project not found",
  });

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if ((current?.archivedAt != null) === archived) return;
    await tx
      .update(projects)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(projects.id, projectId));
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: archived ? "project.archived" : "project.restored",
      resource: { type: "project", id: projectId },
      metadata: { projectName: node.name },
    });
  });

  return readProjectDetail(projectId, level);
};
