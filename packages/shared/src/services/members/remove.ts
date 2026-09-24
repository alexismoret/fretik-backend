import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import { onMemberLeftOrganization } from "../../lib/auth-membership";
import { badRequest, forbidden, throwHttpError } from "../../lib/errors";
import { organizationAdapter } from "../../lib/org-adapter";
import { recordAccessEvent } from "../access/record-event";
import { findMembership } from "./find";

/**
 * Remove someone from the organization, and so from every one of its teams.
 * The admins decide (`members.manage`); an owner is removed only by another
 * owner, who is then the one the organization keeps.
 *
 * Leaving is not removing: someone taking themselves out goes through
 * "Leave the organization" (Better Auth's `/organization/leave`), which is
 * where the last owner is kept from walking out.
 *
 * Better Auth's adapter makes the write — it releases the seats the person
 * held in each team, which the seat limit is counted against — and what
 * follows a departure is `onMemberLeftOrganization`'s: their cached access
 * dropped, their private workflows paused, their name off notification lists.
 */
export const removeOrganizationMember = async (input: {
  principal: UserPrincipal;
  userId: string;
}): Promise<void> => {
  const { principal } = input;
  const { organizationId } = principal;
  await requireCapability({ principal, capability: "members.manage" });
  if (input.userId === principal.userId) {
    return throwHttpError(
      400,
      badRequest("To leave the organization, use Leave the organization."),
    );
  }

  const target = await findMembership(organizationId, input.userId);
  if (target.role === "owner" && principal.orgRole !== "owner") {
    return throwHttpError(403, forbidden("Only an owner can remove an owner."));
  }

  const adapter = await organizationAdapter();
  await adapter.deleteMember({
    memberId: target.memberId,
    organizationId,
    userId: target.userId,
  });
  // After the adapter's own transaction: the journal records what happened.
  await recordAccessEvent({
    organizationId,
    actorUserId: principal.userId,
    action: "member.removed",
    principal: { type: "user", id: target.userId },
    metadata: { userName: target.name, email: target.email, role: target.role },
  });
  await onMemberLeftOrganization({ organizationId, userId: target.userId });
};
