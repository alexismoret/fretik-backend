import { guestAccessExpiry } from "../../../authz/guests";
import type { UserPrincipal } from "../../../authz/principal";
import { projectParticipants } from "../../../authz/project-people";
import db from "../../../db";
import { notFound, throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type {
  HolderPrincipalType,
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { getOrganizationAccessPolicy } from "../../organization/access-policy";
import { changeInvitationLevel } from "../guests/change-invitation-level";
import { recordAccessEvent } from "../record-event";
import { tellRequestersAnswered } from "../requests/answered-by-share";
import { settleRequestsAnsweredBy } from "../requests/settle-requests";
import { afterAccessChange } from "./after-change";
import { describeResourceAccess } from "./describe";
import {
  assertSomeoneKeepsFullAccess,
  lockGrants,
  upsertGrants,
} from "./grant-store";
import { requireSharingRights } from "./manage-rights";
import { principalKey, resolvePrincipals } from "./principals";
import { assertGuestLevel, assertShareable } from "./share";

/**
 * Change one holder's level — the row menu of the share dialog. Takes full
 * access; not the sharing policy, which governs new shares only. A guest is
 * held to a guest's ceiling, and keeps the end of their access period: a
 * new level is not a new period. An address still invited is changed on its
 * invitation (`guests/change-invitation-level.ts`).
 *
 * A restricted item whose owner is gone keeps at least one person or group
 * with full access (`LAST_FULL_ACCESS`): without them nobody could share it,
 * or delete it, again. Who reaches the item does not change, so neither does
 * the assistant's search index.
 */
export const changeGrantLevel = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
  holder: { type: HolderPrincipalType; id: string };
  level: AccessLevel;
}): Promise<ResourceAccess> => {
  const { principal, type, id, level } = input;
  const { node } = await requireSharingRights({ principal, type, id });
  if (input.holder.type === "invitation") {
    await changeInvitationLevel({
      principal,
      node,
      type,
      invitationId: input.holder.id,
      level,
    });
    return describeResourceAccess({ principal, type, id });
  }
  const holder = { type: input.holder.type, id: input.holder.id };
  assertShareable(type, level, [holder]);
  const who = (await resolvePrincipals(principal.organizationId, [holder])).get(
    principalKey(holder),
  );
  // A guest's grant ends with a guest's period: one written by this change
  // (a seat in a chat becoming a grant to read it) starts one, and one that
  // has an end keeps it.
  let guestExpiry: Date | null = null;
  if (who?.guest === true) {
    const inProject =
      node.projectId !== null &&
      (
        await projectParticipants({
          organizationId: principal.organizationId,
          projectId: node.projectId,
          userIds: [who.id],
        })
      ).has(who.id);
    assertGuestLevel(node, level, who.name, inProject);
    guestExpiry = guestAccessExpiry(
      await getOrganizationAccessPolicy(principal.organizationId),
    );
  }

  const settled = await db.transaction(async (tx) => {
    const current =
      (await lockGrants(tx, { type, id }, [holder]))[0] ??
      throwHttpError(404, notFound("Access not found"));
    if (current.level === level) return [];
    const endsAt = current.expiresAt ?? guestExpiry;
    if (current.level === "full") {
      await assertSomeoneKeepsFullAccess(tx, node, [holder]);
    }
    await upsertGrants(tx, {
      organizationId: principal.organizationId,
      resource: { type, id },
      refs: [holder],
      level,
      actorUserId: principal.userId,
      expiries: new Map(
        endsAt === null ? [] : [[principalKey(holder), endsAt]],
      ),
    });
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "grant.updated",
      resource: { type, id },
      principal: holder,
      metadata: {
        level,
        previousLevel: current.level,
        principalName: who?.name ?? null,
        resourceName: node.name,
      },
    });
    // Raising someone to what they asked for answers them.
    return settleRequestsAnsweredBy(tx, {
      organizationId: principal.organizationId,
      resource: { type, id, name: node.name },
      userIds: holder.type === "user" ? [holder.id] : [],
      level,
      deciderUserId: principal.userId,
    });
  });
  await afterAccessChange({ organizationId: principal.organizationId, type });
  await tellRequestersAnswered({
    principal,
    settled,
    resource: { type, id, name: node.name },
    level,
  });

  return describeResourceAccess({ principal, type, id });
};
