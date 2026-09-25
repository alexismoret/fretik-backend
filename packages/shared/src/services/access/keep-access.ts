import type { Executor } from "../../db";
import { accessGrants } from "../../db/schema";
import type { AccessResourceType } from "../../schemas/access";

/**
 * Restricting something one does not own must not lock oneself out of it.
 *
 * A restricted resource is reached by its owner and its grants only, so a
 * team member with full access who restricts a colleague's page would lose it
 * the moment they saved. They keep it through a `full` grant written in the
 * same transaction — what they had, made explicit, and visible in the share
 * dialog like any other grant.
 */
export const keepAccessAfterRestricting = async (input: {
  tx: Executor;
  resourceType: AccessResourceType;
  resourceId: string;
  organizationId: string;
  ownerUserId: string | null;
  actingUserId: string;
}): Promise<void> => {
  if (input.actingUserId === input.ownerUserId) return;
  await input.tx
    .insert(accessGrants)
    .values({
      organizationId: input.organizationId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      principalType: "user",
      principalId: input.actingUserId,
      level: "full",
      grantedByUserId: input.actingUserId,
    })
    .onConflictDoUpdate({
      target: [
        accessGrants.resourceType,
        accessGrants.resourceId,
        accessGrants.principalType,
        accessGrants.principalId,
      ],
      set: { level: "full" },
    });
};
