import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { requireAccess } from "../../authz/access";
import { bumpAccessVersion } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import { throwNotVisible } from "../../authz/refusals";
import db, { type Executor } from "../../db";
import {
  accessGrants,
  aiConversations,
  aiMemories,
  aiMemoryHistory,
  aiVectors,
  documents,
  folders,
  pages,
  projects,
  workflows,
} from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import type { AccessResourceType } from "../../schemas/access";
import { recordAccessEvent } from "../access/record-event";
import {
  refreshAclsAfterAccessChange,
  refreshVectorAcls,
} from "../ai-vectors/acl";

/** What a deleted project held, now back in its team. */
export interface ReleasedContent {
  readonly conversations: number;
  readonly folders: number;
  readonly documents: number;
  readonly pages: number;
  readonly workflows: number;
}

/**
 * Delete a project — full access.
 *
 * What it holds is not deleted with it: everything goes back to its team,
 * where it was made, and nobody gains access they did not have.
 *
 *   - A chat is kept to its participants and the people it is shared with.
 *   - From a project open to its team, the rest keeps its restrictions: the
 *     team reached it already.
 *   - From a restricted project, what was open to the project is restricted,
 *     to its owner and the people it is shared with: the team never reached
 *     it. A workflow restricted this way runs as its owner, like any other.
 *   - Files and folders land at the root of the team's Drive, each folder
 *     with everything in it.
 *
 * Only what it kept for the assistant goes with it: its instructions, and
 * its notes with their history and search vectors.
 *
 * The project's members lose what they reached only through it, and what
 * was shared with the project is no longer shared with anyone. All of it in
 * one transaction, the assistant's search audiences included; the cached
 * principals of the organization drop the project once it commits.
 */
export const deleteProject = async (input: {
  principal: UserPrincipal;
  projectId: string;
}): Promise<ReleasedContent> => {
  const { principal, projectId } = input;
  await requireAccess({
    principal,
    type: "project",
    id: projectId,
    required: "full",
    notFoundMessage: "Project not found",
  });

  const released = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ name: projects.name, restricted: projects.accessRestricted })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!project) return throwNotVisible("Project not found");
    const restrict = project.restricted;

    // What was shared WITH the project loses that audience when its grants go
    // with the project (the `access_forget_project_grants` trigger).
    const sharedWithIt = await tx
      .select({
        type: accessGrants.resourceType,
        id: accessGrants.resourceId,
      })
      .from(accessGrants)
      .where(
        and(
          eq(accessGrants.principalType, "project"),
          eq(accessGrants.principalId, projectId),
        ),
      );

    const conversations = await tx
      .update(aiConversations)
      .set({ projectId: null, accessRestricted: true })
      .where(eq(aiConversations.projectId, projectId))
      .returning({ id: aiConversations.id });

    const folderIds = await releaseFolders(tx, projectId, restrict);
    const documentIds = await releaseDocuments(tx, projectId, restrict);
    const pageIds = await releaseFlat(tx, pages, projectId, restrict);
    const workflowIds = await releaseFlat(tx, workflows, projectId, restrict);
    await forgetProjectNotes(tx, projectId);

    await tx.delete(projects).where(eq(projects.id, projectId));

    // Every audience that named the project, rewritten from the rows as they
    // are now.
    await refreshVectorAcls({
      executor: tx,
      type: "document",
      ids: documentIds,
    });
    await refreshVectorAcls({ executor: tx, type: "page", ids: pageIds });
    await refreshVectorAcls({
      executor: tx,
      type: "workflow",
      ids: workflowIds,
    });
    for (const item of sharedWithIt) {
      if (!hasSearchAudience(item.type)) continue;
      // oxlint-disable-next-line no-await-in-loop -- a few items, in this transaction
      await refreshAclsAfterAccessChange({
        executor: tx,
        type: item.type,
        id: item.id,
      });
    }

    const counts: ReleasedContent = {
      conversations: conversations.length,
      folders: folderIds.length,
      documents: documentIds.length,
      pages: pageIds.length,
      workflows: workflowIds.length,
    };
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "project.deleted",
      resource: { type: "project", id: projectId },
      metadata: { projectName: project.name, restricted: restrict, ...counts },
    });
    return counts;
  });
  await bumpAccessVersion(principal.organizationId);
  return released;
};

/**
 * The project's notes, gone with it. Their rows go by cascade with the
 * project; their history and their search vectors, which hold their content
 * but no key to the project, go first.
 */
const forgetProjectNotes = async (
  tx: Executor,
  projectId: string,
): Promise<void> => {
  const notes = await tx
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(eq(aiMemories.projectId, projectId));
  for (const chunk of chunkForBulk(notes.map((note) => note.id))) {
    // oxlint-disable-next-line no-await-in-loop -- one statement per chunk, in this transaction
    await tx
      .delete(aiMemoryHistory)
      .where(inArray(aiMemoryHistory.memoryId, chunk));
    // oxlint-disable-next-line no-await-in-loop -- same
    await tx
      .delete(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "memories"),
          inArray(aiVectors.sourceId, chunk),
        ),
      );
  }
};

/** The kinds of items whose audience the assistant's search keeps. */
const hasSearchAudience = (
  type: AccessResourceType,
): type is "folder" | "document" | "page" | "workflow" =>
  type === "folder" ||
  type === "document" ||
  type === "page" ||
  type === "workflow";

/**
 * The project's folders, back in the team's Drive. Its top folders stay top
 * folders, now of the team's root; restricted when the project was, so the
 * trees they hold stay with the people who reached them.
 */
const releaseFolders = async (
  tx: Executor,
  projectId: string,
  restrict: boolean,
): Promise<string[]> => {
  if (restrict) {
    await tx
      .update(folders)
      .set({ accessRestricted: true })
      .where(
        and(eq(folders.projectId, projectId), isNull(folders.parentFolderId)),
      );
  }
  const released = await tx
    .update(folders)
    .set({ projectId: null })
    .where(eq(folders.projectId, projectId))
    .returning({ id: folders.id });
  return released.map((row) => row.id);
};

/** The project's files; those at its root are restricted when it was. */
const releaseDocuments = async (
  tx: Executor,
  projectId: string,
  restrict: boolean,
): Promise<string[]> => {
  if (restrict) {
    await tx
      .update(documents)
      .set({ accessRestricted: true })
      .where(
        and(eq(documents.projectId, projectId), isNull(documents.folderId)),
      );
  }
  const released = await tx
    .update(documents)
    .set({ projectId: null })
    .where(eq(documents.projectId, projectId))
    .returning({ id: documents.id });
  return released.map((row) => row.id);
};

/**
 * The project's pages or workflows. Restricted when the project was, through
 * both restriction columns (`authz/legacy-privacy.ts`): the legacy one names
 * the owner.
 */
const releaseFlat = async (
  tx: Executor,
  table: typeof pages | typeof workflows,
  projectId: string,
  restrict: boolean,
): Promise<string[]> => {
  if (restrict) {
    await tx
      .update(table)
      .set({ accessRestricted: true, userId: sql`${table.ownerUserId}` })
      .where(and(eq(table.projectId, projectId), not(table.accessRestricted)));
  }
  const released = await tx
    .update(table)
    .set({ projectId: null })
    .where(eq(table.projectId, projectId))
    .returning({ id: table.id });
  return released.map((row) => row.id);
};
