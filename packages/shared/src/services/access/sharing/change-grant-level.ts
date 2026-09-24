import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { notFound, throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type {
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
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
import { type PrincipalRef, principalName } from "./principals";
import { assertShareable } from "./share";

/**
 * Change one holder's level — the row menu of the share dialog. Takes full
 * access; not the sharing policy, which governs new shares only.
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
  holder: PrincipalRef;
  level: AccessLevel;
}): Promise<ResourceAccess> => {
  const { principal, type, id, holder, level } = input;
  const { node } = await requireSharingRights({ principal, type, id });
  assertShareable(type, level, [holder]);
  const holderName = await principalName(principal.organizationId, holder);

  const settled = await db.transaction(async (tx) => {
    const current =
      (await lockGrants(tx, { type, id }, [holder]))[0] ??
      throwHttpError(404, notFound("Access not found"));
    if (current.level === level) return [];
    if (current.level === "full") {
      await assertSomeoneKeepsFullAccess(tx, node, [holder]);
    }
    await upsertGrants(tx, {
      organizationId: principal.organizationId,
      resource: { type, id },
      refs: [holder],
      level,
      actorUserId: principal.userId,
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
        principalName: holderName,
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
