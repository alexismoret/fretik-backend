import type { UserPrincipal } from "../../../authz/principal";
import type { LoadedNode } from "../../../authz/resources/types";
import db, { type Executor } from "../../../db";
import { notFound, throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { recordAccessEvent } from "../record-event";
import { assertShareable } from "../sharing/share";
import {
  lockInvitationGrant,
  upsertInvitationGrant,
} from "./invitation-grants";
import {
  assertInvitationLevel,
  findPendingInvitation,
  type InvitationFacts,
} from "./invitation-terms";

/**
 * Change the level an address still invited will have on a resource — the
 * share dialog's row menu on an invitation. The caller has full access
 * (`changeGrantLevel` checked it); the level is held to the invitation's
 * terms, as when it was sent. An invitation no longer pending answers 404,
 * like a grant that is not there.
 */
export const changeInvitationLevel = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  invitationId: string;
  level: AccessLevel;
}): Promise<void> => {
  const { principal, node, type, invitationId, level } = input;
  // A person's levels: an invitation is someone, not a group.
  assertShareable(type, level, [{ type: "user", id: principal.userId }]);
  const resource = { type, id: node.id };

  await db.transaction(async (tx) => {
    const { facts, current } = await lockWaitingGrant(tx, {
      organizationId: principal.organizationId,
      resource,
      invitationId,
    });
    if (current.level === level) return;
    assertInvitationLevel(node, level, facts);
    await upsertInvitationGrant(tx, {
      organizationId: principal.organizationId,
      resource,
      invitationId,
      level,
      actorUserId: principal.userId,
    });
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "grant.updated",
      resource,
      principal: { type: "invitation", id: invitationId },
      metadata: {
        level,
        previousLevel: current.level,
        principalName: facts.email,
        resourceName: node.name,
      },
    });
  });
};

/**
 * The invitation, still waiting, and its grant on the resource, locked —
 * or 404, like a grant that is not there.
 */
const lockWaitingGrant = async (
  tx: Executor,
  input: {
    organizationId: string;
    resource: { type: SharingResourceType; id: string };
    invitationId: string;
  },
): Promise<{ facts: InvitationFacts; current: { level: AccessLevel } }> => {
  const facts = await findPendingInvitation(
    tx,
    input.organizationId,
    input.invitationId,
  );
  const current = facts
    ? await lockInvitationGrant(tx, input.resource, input.invitationId)
    : null;
  if (!facts || !current) {
    return throwHttpError(404, notFound("Access not found"));
  }
  return { facts, current };
};
