import { eq } from "drizzle-orm";
import type { UserPrincipal } from "../../../authz/principal";
import { throwForbidden } from "../../../authz/refusals";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { aiConversations, documents, folders } from "../../../db/schema";
import type {
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { refreshAclsAfterAccessChange } from "../../ai-vectors/acl";
import { updatePage } from "../../pages/update";
import { updateWorkflow } from "../../workflows/update";
import { keepAccessAfterRestricting } from "../keep-access";
import { recordAccessEvent } from "../record-event";
import { describeResourceAccess } from "./describe";
import { requireSharingRights } from "./manage-rights";

/**
 * Restrict a resource — only its owner and the people and groups it is shared
 * with reach it — or open it again to what it inherits from (its folder, its
 * project, its team).
 *
 * Changing who may see something is sharing: it takes full access. A
 * workflow is restricted by its owner only: restricted, it runs with its
 * owner's access, and nobody may make it act as someone else. Pages and
 * workflows go through their own update, which keeps their legacy privacy
 * column in step and re-checks the apps a workflow may use; Drive items are
 * written here. Either way the change, the journal entry and the assistant's
 * search index move in one transaction. A chat opened to its team is read
 * there; taking part in it stays a seat someone gives.
 */
export const setGeneralAccess = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
  restricted: boolean;
}): Promise<ResourceAccess> => {
  const { principal, type, id, restricted } = input;
  const { node } = await requireSharingRights({ principal, type, id });

  if (node.restricted !== restricted) {
    switch (type) {
      case "page":
        await updatePage({
          pageId: id,
          teamId: teamOf(node),
          actingUserId: principal.userId,
          principal,
          // The legacy spelling of a restriction: the caller's own id
          // restricts and keeps the owner; null opens it.
          input: { userId: restricted ? principal.userId : null },
        });
        break;
      case "workflow":
        if (
          restricted &&
          node.ownerUserId !== null &&
          node.ownerUserId !== principal.userId
        ) {
          throwForbidden(
            "Only its owner can restrict a workflow: restricted, it runs with its owner's access.",
          );
        }
        await updateWorkflow({
          id,
          teamId: teamOf(node),
          principal,
          input: { userId: restricted ? principal.userId : null },
        });
        break;
      case "folder":
      case "document":
        await restrictDriveItem({ principal, type, node, restricted });
        break;
      case "conversation":
        await restrictConversation({ principal, node, restricted });
        break;
    }
  }

  return describeResourceAccess({ principal, type, id });
};

/** Pages and workflows always belong to a team. */
const teamOf = (node: LoadedNode): string => {
  if (node.teamId === null) {
    return throwForbidden("This item belongs to no team.");
  }
  return node.teamId;
};

const restrictDriveItem = async (input: {
  principal: UserPrincipal;
  type: "folder" | "document";
  node: LoadedNode;
  restricted: boolean;
}): Promise<void> => {
  const { principal, type, node, restricted } = input;
  await db.transaction(async (tx) => {
    if (type === "folder") {
      await tx
        .update(folders)
        .set({ accessRestricted: restricted })
        .where(eq(folders.id, node.id));
    } else {
      await tx
        .update(documents)
        .set({ accessRestricted: restricted })
        .where(eq(documents.id, node.id));
    }
    if (restricted) {
      await keepAccessAfterRestricting({
        tx,
        resourceType: type,
        resourceId: node.id,
        organizationId: node.organizationId,
        ownerUserId: node.ownerUserId,
        actingUserId: principal.userId,
      });
    }
    await recordAccessEvent({
      executor: tx,
      organizationId: node.organizationId,
      actorUserId: principal.userId,
      action: "restriction.changed",
      resource: { type, id: node.id },
      metadata: { restricted, resourceName: node.name },
    });
    await refreshAclsAfterAccessChange({ executor: tx, type, id: node.id });
  });
};

/** Open a chat to its team to read, or keep it to the people given it again. */
const restrictConversation = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  restricted: boolean;
}): Promise<void> => {
  const { principal, node, restricted } = input;
  await db.transaction(async (tx) => {
    await tx
      .update(aiConversations)
      .set({ accessRestricted: restricted })
      .where(eq(aiConversations.id, node.id));
    await recordAccessEvent({
      executor: tx,
      organizationId: node.organizationId,
      actorUserId: principal.userId,
      action: "restriction.changed",
      resource: { type: "conversation", id: node.id },
      metadata: { restricted, resourceName: node.name },
    });
  });
};
