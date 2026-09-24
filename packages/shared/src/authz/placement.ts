import { eq } from "drizzle-orm";
import db from "../db";
import { projects } from "../db/schema";
import { badRequest, teamRequired, throwHttpError } from "../lib/errors";
import { ERROR_CODES } from "../schemas/errors";
import { requireAccess } from "./access";
import { requireCapability } from "./gates";
import type { Principal } from "./principal";
import { throwNotVisible } from "./refusals";
import type { LoadedNode } from "./resources/types";

/**
 * Where new content lands, and whether the person may put it there — one
 * decision for every door that creates something: the API's routes, the
 * assistant's tools, the approvals that apply them later.
 *
 *   in a folder           its team and its project. Edit on the folder; and,
 *                         for a folder of no project, contributing to its
 *                         team (`team.content.create`), as at its root.
 *   at a project's root   the project's team. Taking part in the project
 *                         (`use`), whatever team one has open.
 *   at the team's root    the team the caller has open. Contributing to it —
 *                         except for a chat, which any member of the team
 *                         starts (a viewer chats).
 *
 * An archived project takes nothing new (409 `PROJECT_ARCHIVED`), through its
 * root or any folder in it.
 */
export interface Placement {
  readonly teamId: string;
  readonly projectId: string | null;
}

export const requirePlacement = async (input: {
  principal: Principal;
  /** The team the caller has open: where content lands when nothing else says. */
  activeTeamId: string | null | undefined;
  folderId?: string | null;
  projectId?: string | null;
  /** False for a chat, which is no contribution to the team's content. */
  contributes?: boolean;
}): Promise<Placement> => {
  const { principal } = input;
  const contributes = input.contributes ?? true;

  if (input.folderId) {
    const { node } = await requireAccess({
      principal,
      type: "folder",
      id: input.folderId,
      required: "edit",
      notFoundMessage: "Folder not found",
    });
    const teamId = node.teamId ?? throwNotVisible("Folder not found");
    const projectId = projectOfTree(node);
    if (input.projectId && input.projectId !== projectId) {
      return throwHttpError(
        400,
        badRequest("This folder is not in that project."),
      );
    }
    if (projectId !== null) {
      await assertProjectOpenForContent(projectId);
    } else if (contributes) {
      await requireCapability({
        principal,
        capability: "team.content.create",
        teamId,
      });
    }
    return { teamId, projectId };
  }

  if (input.projectId) {
    const { node } = await requireAccess({
      principal,
      type: "project",
      id: input.projectId,
      required: "use",
      notFoundMessage: "Project not found",
    });
    await assertProjectOpenForContent(node.id);
    const teamId = node.teamId ?? throwNotVisible("Project not found");
    return { teamId, projectId: node.id };
  }

  const teamId = input.activeTeamId;
  if (!teamId) return throwHttpError(403, teamRequired());
  if (contributes) {
    await requireCapability({
      principal,
      capability: "team.content.create",
      teamId,
    });
  }
  return { teamId, projectId: null };
};

/**
 * The project of a Drive item's tree: the one its top folder names, as the
 * rules read it. Every item of the tree carries it too (`project_id`), which
 * is what the Drive's lists read.
 */
export const projectOfTree = (node: LoadedNode): string | null => {
  let top = node;
  while (top.parent !== null) top = top.parent;
  return top.projectId;
};

/** Whether the project is archived: it takes nothing new until restored. */
export const isProjectArchived = async (
  projectId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.archivedAt != null;
};

/** Refuse when the project is archived: it takes nothing new until restored. */
export const assertProjectOpenForContent = async (
  projectId: string,
): Promise<void> => {
  if (await isProjectArchived(projectId)) {
    throwHttpError(409, {
      code: ERROR_CODES.PROJECT_ARCHIVED,
      message: "This project is archived. Restore it to add to it.",
    });
  }
};

/**
 * Refuse any change to what the project keeps for the assistant (its notes)
 * while it is archived: it reads as it was until restored.
 */
export const assertProjectNotArchived = async (
  projectId: string,
): Promise<void> => {
  if (await isProjectArchived(projectId)) {
    throwHttpError(409, {
      code: ERROR_CODES.PROJECT_ARCHIVED,
      message: "This project is archived. Restore it to change it.",
    });
  }
};

/**
 * The team a project's lists read in: its own, for anyone who reaches the
 * project (`view`), whatever team they have open. 404 for a project they do
 * not reach, like one that does not exist.
 */
export const teamOfProject = async (
  principal: Principal,
  projectId: string,
): Promise<string> => {
  const { node } = await requireAccess({
    principal,
    type: "project",
    id: projectId,
    required: "view",
    notFoundMessage: "Project not found",
  });
  return node.teamId ?? throwNotVisible("Project not found");
};
