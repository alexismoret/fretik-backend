import type { UserPrincipal } from "../../../authz/principal";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { organizationAdapter } from "../../../lib/org-adapter";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { recordAccessEvent } from "../record-event";
import {
  deleteInvitationGrant,
  invitationHoldsGrants,
  lockInvitationGrant,
} from "./invitation-grants";
import { findPendingInvitation } from "./invitation-terms";

/**
 * Take an item out of what an invitation gives — the share dialog's "Remove"
 * on an address still invited. The caller has full access (`revokeGrant`
 * checked it). Removing what is not there is a no-op, like any grant.
 *
 * A GUEST's invitation that no longer gives anything is withdrawn with it:
 * a guest is invited only to see what is shared with them, and accepting an
 * invitation into an organization where nothing waits would be a dead end. A
 * future member's invitation stands — it still joins them to a team.
 */
export const removeInvitationGrant = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  invitationId: string;
}): Promise<void> => {
  const { principal, node, type, invitationId } = input;
  const { organizationId } = principal;
  const resource = { type, id: node.id };

  const withdraw = await db.transaction(async (tx) => {
    const current = await lockInvitationGrant(tx, resource, invitationId);
    if (!current) return null;
    const facts = await findPendingInvitation(tx, organizationId, invitationId);
    await deleteInvitationGrant(tx, resource, invitationId);
    await recordAccessEvent({
      executor: tx,
      organizationId,
      actorUserId: principal.userId,
      action: "grant.removed",
      resource,
      principal: { type: "invitation", id: invitationId },
      metadata: {
        previousLevel: current.level,
        principalName: facts?.email ?? null,
        resourceName: node.name,
      },
    });
    const empty =
      facts?.role === "guest" &&
      !(await invitationHoldsGrants(tx, invitationId));
    return empty ? facts : null;
  });
  if (withdraw === null) return;

  const adapter = await organizationAdapter();
  const canceled = await adapter.updateInvitation({
    invitationId,
    status: "canceled",
    fromStatus: "pending",
  });
  if (!canceled) return;
  await recordAccessEvent({
    organizationId,
    actorUserId: principal.userId,
    action: "invitation.canceled",
    principal: { type: "invitation", id: invitationId },
    metadata: { email: withdraw.email, role: withdraw.role, teamId: null },
  });
};
