import { requireCapability } from "../../authz/gates";
import { bumpAccessVersion } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { projects } from "../../db/schema";
import { internalError, teamRequired, throwHttpError } from "../../lib/errors";
import type { CreateProjectInput, ProjectDetail } from "../../schemas/projects";
import { recordAccessEvent } from "../access/record-event";
import { readProjectDetail } from "./read";

/**
 * Create a project in the team the caller has open, owned by them.
 *
 * Who may is the organization's policy in that team (`projects.create`: every
 * member by default, as for anything else they contribute). Open by default:
 * everyone in the team reaches it through their team role; restricted, only
 * the people it is then shared with. A new project changes what the team's
 * people reach, so every cached principal of the organization is dropped once
 * it commits.
 */
export const createProject = async (input: {
  principal: UserPrincipal;
  teamId: string | null | undefined;
  project: CreateProjectInput;
}): Promise<ProjectDetail> => {
  const { principal, project } = input;
  const teamId = input.teamId ?? throwHttpError(403, teamRequired());
  await requireCapability({
    principal,
    capability: "projects.create",
    teamId,
  });

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        organizationId: principal.organizationId,
        teamId,
        name: project.name,
        description: project.description,
        icon: project.icon ?? null,
        color: project.color ?? null,
        ownerUserId: principal.userId,
        accessRestricted: project.restricted,
      })
      .returning({ id: projects.id });
    if (!row) return throwHttpError(500, internalError());
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "project.created",
      resource: { type: "project", id: row.id },
      principal: { type: "team", id: teamId },
      metadata: { projectName: project.name, restricted: project.restricted },
    });
    return row;
  });
  await bumpAccessVersion(principal.organizationId);

  return readProjectDetail(created.id, "full");
};
