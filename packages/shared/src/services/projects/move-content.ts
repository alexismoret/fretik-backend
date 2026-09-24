import { eq, sql } from "drizzle-orm";
import { requireAccess } from "../../authz/access";
import {
  assertProjectOpenForContent,
  projectOfTree,
} from "../../authz/placement";
import type { UserPrincipal } from "../../authz/principal";
import { throwNotVisible } from "../../authz/refusals";
import db, { type Executor } from "../../db";
import {
  aiConversations,
  documents,
  folders,
  pages,
  projects,
  workflows,
} from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { deleteKeysByPrefix } from "../../lib/redis";
import type { ProjectContentType } from "../../schemas/projects";
import { recordAccessEvent } from "../access/record-event";
import { refreshAclsAfterAccessChange } from "../ai-vectors/acl";
import { relocateFolderTree } from "../folders/relocate";

/**
 * Put an item in a project, or take it out to its team: "Move to project" on
 * a chat, a file, a folder, a page or a workflow.
 *
 * Moving changes who reaches it the way sharing does, so it takes full access
 * on the item. Landing in a project takes taking part in it (`use`); the
 * project must be the item's own team's — content never changes team — and
 * must take content (not archived). A file or a folder goes to the root of
 * its new place, a folder with everything in it.
 *
 * Only the place changes: whether the item is restricted, who it is shared
 * with and who takes part in it stay as they were. A chat's participants who
 * do not take part in its new project read it from then on (`levelCeiling`).
 * The assistant's search audience moves in the same transaction, and the
 * move is journaled with it.
 */
export const moveToProject = async (input: {
  principal: UserPrincipal;
  type: ProjectContentType;
  id: string;
  projectId: string | null;
}): Promise<{ projectId: string | null }> => {
  const { principal, type, id, projectId } = input;
  const { node } = await requireAccess({
    principal,
    type,
    id,
    required: "full",
  });
  const teamId = node.teamId ?? throwNotVisible();
  const from =
    type === "folder" || type === "document"
      ? projectOfTree(node)
      : node.projectId;

  let destinationName: string | null = null;
  if (projectId !== null) {
    const { node: project } = await requireAccess({
      principal,
      type: "project",
      id: projectId,
      required: "use",
      notFoundMessage: "Project not found",
    });
    if (project.teamId !== teamId) {
      return throwHttpError(
        400,
        badRequest(
          "An item moves into a project of its own team: content never changes team.",
        ),
      );
    }
    await assertProjectOpenForContent(projectId);
    destinationName = project.name;
  }

  const origin =
    from === null
      ? null
      : {
          id: from,
          name:
            (
              await db
                .select({ name: projects.name })
                .from(projects)
                .where(eq(projects.id, from))
            )[0]?.name ?? null,
        };

  await db.transaction(async (tx) => {
    const moved = await MOVERS[type](tx, { id, teamId, projectId });
    if (!moved) return;
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "project.content_moved",
      resource: { type, id },
      metadata: {
        resourceName: node.name,
        from: origin,
        to:
          projectId === null ? null : { id: projectId, name: destinationName },
      },
    });
  });
  if (type === "document") await deleteKeysByPrefix(`document:${id}`);

  return { projectId };
};

interface Move {
  readonly id: string;
  readonly teamId: string;
  readonly projectId: string | null;
}

/** Moves one kind of item; answers whether anything moved. */
type Mover = (tx: Executor, move: Move) => Promise<boolean>;

/** To the root of its new place, with everything below it. */
const moveFolder: Mover = async (tx, { id, teamId, projectId }) => {
  const [folder] = await tx
    .select({
      name: folders.name,
      parentFolderId: folders.parentFolderId,
      fullPath: folders.fullPath,
      projectId: folders.projectId,
    })
    .from(folders)
    .where(eq(folders.id, id))
    .for("update");
  if (!folder) return throwNotVisible("Folder not found");
  if (folder.parentFolderId === null && folder.projectId === projectId) {
    return false;
  }
  if (folder.parentFolderId !== null) {
    await tx
      .update(folders)
      .set({ subFolderCount: sql`${folders.subFolderCount} - 1` })
      .where(eq(folders.id, folder.parentFolderId));
  }
  const newFullPath = `/${folder.name}`;
  await tx
    .update(folders)
    .set({ parentFolderId: null, fullPath: newFullPath })
    .where(eq(folders.id, id));
  await relocateFolderTree(tx, {
    folderId: id,
    teamId,
    oldFullPath: folder.fullPath,
    newFullPath,
    projectId,
  });
  await refreshAclsAfterAccessChange({ executor: tx, type: "folder", id });
  return true;
};

/** To the root of its new place. */
const moveDocument: Mover = async (tx, { id, projectId }) => {
  const [document] = await tx
    .select({ folderId: documents.folderId, projectId: documents.projectId })
    .from(documents)
    .where(eq(documents.id, id))
    .for("update");
  if (!document) return throwNotVisible("Document not found");
  if (document.folderId === null && document.projectId === projectId) {
    return false;
  }
  if (document.folderId !== null) {
    await tx
      .update(folders)
      .set({ documentCount: sql`${folders.documentCount} - 1` })
      .where(eq(folders.id, document.folderId));
  }
  await tx
    .update(documents)
    .set({ folderId: null, projectId })
    .where(eq(documents.id, id));
  await refreshAclsAfterAccessChange({ executor: tx, type: "document", id });
  return true;
};

const moveConversation: Mover = async (tx, { id, projectId }) => {
  const moved = await tx
    .update(aiConversations)
    .set({ projectId })
    .where(
      sql`${aiConversations.id} = ${id} AND ${aiConversations.projectId} IS DISTINCT FROM ${projectId}`,
    )
    .returning({ id: aiConversations.id });
  return moved.length > 0;
};

const movePage: Mover = async (tx, { id, projectId }) => {
  const moved = await tx
    .update(pages)
    .set({ projectId })
    .where(
      sql`${pages.id} = ${id} AND ${pages.projectId} IS DISTINCT FROM ${projectId}`,
    )
    .returning({ id: pages.id });
  if (moved.length === 0) return false;
  await refreshAclsAfterAccessChange({ executor: tx, type: "page", id });
  return true;
};

const moveWorkflow: Mover = async (tx, { id, projectId }) => {
  const moved = await tx
    .update(workflows)
    .set({ projectId })
    .where(
      sql`${workflows.id} = ${id} AND ${workflows.projectId} IS DISTINCT FROM ${projectId}`,
    )
    .returning({ id: workflows.id });
  if (moved.length === 0) return false;
  await refreshAclsAfterAccessChange({ executor: tx, type: "workflow", id });
  return true;
};

const MOVERS: Record<ProjectContentType, Mover> = {
  folder: moveFolder,
  document: moveDocument,
  conversation: moveConversation,
  page: movePage,
  workflow: moveWorkflow,
};
