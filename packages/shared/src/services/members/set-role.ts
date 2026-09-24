import { eq } from "drizzle-orm";
import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { member } from "../../db/schema";
import { onMembershipChanged } from "../../lib/auth-membership";
import { forbidden, throwHttpError } from "../../lib/errors";
import type { AssignableOrganizationRole } from "../../schemas/access";
import { ERROR_CODES } from "../../schemas/errors";
import type { OrganizationMember } from "../../schemas/members";
import { recordAccessEvent } from "../access/record-event";
import { getOrganizationMember } from "./directory";
import { findMembership, lockOwners } from "./find";

/**
 * Make someone an admin of the organization, or a member again. The admins
 * decide (`members.manage`).
 *
 * An owner is changed only by an owner — an admin could otherwise demote the
 * person who can demote them — and never when they are the last one: the
 * organization always keeps someone who can reach everything it is.
 *
 * Written here rather than through Better Auth's `update-member-role`, whose
 * hook does not know who acted: the role and its journal entry commit
 * together, and the change reaches every open session on its next request.
 */
export const setOrganizationRole = async (input: {
  principal: UserPrincipal;
  userId: string;
  role: AssignableOrganizationRole;
}): Promise<OrganizationMember> => {
  const { principal } = input;
  const { organizationId } = principal;
  await requireCapability({ principal, capability: "members.manage" });

  const target = await findMembership(organizationId, input.userId);
  if (target.role === input.role) {
    return getOrganizationMember(organizationId, target.userId);
  }
  if (target.role === "owner" && principal.orgRole !== "owner") {
    return throwHttpError(
      403,
      forbidden("Only an owner can change an owner's role."),
    );
  }

  await db.transaction(async (tx) => {
    if (target.role === "owner") {
      const owners = await lockOwners(tx, organizationId);
      if (owners.filter((id) => id !== target.userId).length === 0) {
        throwHttpError(409, {
          code: ERROR_CODES.LAST_OWNER,
          message: "The organization needs at least one owner.",
        });
      }
    }
    await tx
      .update(member)
      .set({ role: input.role })
      .where(eq(member.id, target.memberId));
    await recordAccessEvent({
      executor: tx,
      organizationId,
      actorUserId: principal.userId,
      action: "member.role_changed",
      principal: { type: "user", id: target.userId },
      metadata: { userName: target.name, from: target.role, to: input.role },
    });
  });

  await onMembershipChanged(organizationId);
  return getOrganizationMember(organizationId, target.userId);
};
