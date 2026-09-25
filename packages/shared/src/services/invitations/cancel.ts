import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { notFound, throwHttpError } from "../../lib/errors";
import { organizationAdapter } from "../../lib/org-adapter";
import { dropInvitationGrants } from "../access/guests/invitation-grants";
import { recordAccessEvent } from "../access/record-event";

/**
 * Withdraw a pending invitation, and what it was shared for with it. Whoever
 * may invite into its team may take one back (`members.invite` there); one
 * with no team is an invitation into the organization alone, or a guest's,
 * and the admins' (`members.manage`) — or, for a guest's, the person who
 * sent it. Taking one item off a guest's invitation is the share dialog's.
 *
 * Guarded like every change of an invitation's status: it moves only from
 * `pending`, so an invitation accepted a moment earlier is not "withdrawn"
 * after the fact — it answers 404, like one that does not exist.
 */
export const cancelInvitation = async (input: {
  principal: UserPrincipal;
  invitationId: string;
}): Promise<void> => {
  const { principal } = input;
  const row = await db.query.invitation.findFirst({
    columns: {
      id: true,
      email: true,
      role: true,
      teamId: true,
      status: true,
      inviterId: true,
    },
    where: { id: input.invitationId, organizationId: principal.organizationId },
  });
  if (!row || row.status !== "pending") {
    return throwHttpError(404, notFound("Invitation not found"));
  }
  const ownGuestInvitation =
    row.role === "guest" && row.inviterId === principal.userId;
  if (!ownGuestInvitation) {
    await requireCapability(
      row.teamId === null
        ? { principal, capability: "members.manage" }
        : { principal, capability: "members.invite", teamId: row.teamId },
    );
  }

  const adapter = await organizationAdapter();
  const canceled = await adapter.updateInvitation({
    invitationId: row.id,
    status: "canceled",
    fromStatus: "pending",
  });
  if (!canceled) return throwHttpError(404, notFound("Invitation not found"));

  await db.transaction(async (tx) => {
    const dropped = await dropInvitationGrants(tx, row.id);
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "invitation.canceled",
      principal: { type: "invitation", id: row.id },
      metadata: {
        email: row.email,
        teamId: row.teamId,
        role: row.role,
        items: dropped.length,
      },
    });
  });
};
