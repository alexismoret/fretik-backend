import { type ResolvedResource, requireAccess } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import { throwResourceRefusal } from "../../../authz/refusals";
import type { SharingResourceType } from "../../../schemas/access-sharing";

/**
 * The gate of every change to who may see a resource: full access — sharing
 * is part of it — and never a guest, who only ever receives what is shared
 * with them. Answers 404 for a resource the person cannot see, like every
 * other gate, and 403 saying why otherwise.
 */
export const requireSharingRights = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
}): Promise<ResolvedResource> => {
  const resolved = await requireAccess({ ...input, required: "full" });
  if (input.principal.isGuest) {
    await throwResourceRefusal({
      principal: input.principal,
      resource: {
        type: input.type,
        id: input.id,
        ownerUserId: resolved.node.ownerUserId,
        teamId: resolved.node.teamId,
      },
      required: "full",
      current: resolved.level,
      reason: "GUEST_RESTRICTED",
    });
  }
  return resolved;
};
