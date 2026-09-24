import { HTTPException } from "hono/http-exception";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import type {
  HolderPrincipalType,
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { refreshAclsAfterAccessChange } from "../../ai-vectors/acl";
import { removeInvitationGrant } from "../guests/remove-invitation-grant";
import { recordAccessEvent } from "../record-event";
import { afterAccessChange } from "./after-change";
import { describeResourceAccess } from "./describe";
import {
  assertSomeoneKeepsFullAccess,
  deleteGrants,
  lockGrants,
} from "./grant-store";
import { requireSharingRights } from "./manage-rights";
import { principalName } from "./principals";

/**
 * Take a holder's access away — the row menu of the share dialog. Takes full
 * access, and keeps someone with full access on a restricted item whose owner
 * is gone (`LAST_FULL_ACCESS`). Removing a grant that is not there is a
 * no-op, so a double click does not fail. An address still invited loses the
 * item from its invitation (`guests/remove-invitation-grant.ts`).
 *
 * Answers the dialog's new model, or null when the caller took their own
 * access away and can no longer see the item.
 */
export const revokeGrant = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
  holder: { type: HolderPrincipalType; id: string };
}): Promise<ResourceAccess | null> => {
  const { principal, type, id } = input;
  const { node } = await requireSharingRights({ principal, type, id });
  if (input.holder.type === "invitation") {
    await removeInvitationGrant({
      principal,
      node,
      type,
      invitationId: input.holder.id,
    });
    return describeResourceAccess({ principal, type, id });
  }
  const holder = { type: input.holder.type, id: input.holder.id };
  const holderName = await principalName(principal.organizationId, holder);

  await db.transaction(async (tx) => {
    const [current] = await lockGrants(tx, { type, id }, [holder]);
    if (!current) return;
    if (current.level === "full") {
      await assertSomeoneKeepsFullAccess(tx, node, [holder]);
    }
    await deleteGrants(tx, { type, id }, [holder]);
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "grant.removed",
      resource: { type, id },
      principal: holder,
      metadata: {
        previousLevel: current.level,
        principalName: holderName,
        resourceName: node.name,
      },
    });
    await refreshAclsAfterAccessChange({ executor: tx, type, id });
  });
  await afterAccessChange({ organizationId: principal.organizationId, type });

  try {
    return await describeResourceAccess({ principal, type, id });
  } catch (error) {
    if (error instanceof HTTPException && error.status === 404) return null;
    throw error;
  }
};
