import { sql } from "drizzle-orm";
import { adapterFor, requireAccess } from "../../../authz/access";
import { atLeast } from "../../../authz/levels";
import type { UserPrincipal } from "../../../authz/principal";
import { throwResourceRefusal } from "../../../authz/refusals";
import { levelCeiling } from "../../../authz/rules";
import db from "../../../db";
import { accessRequests } from "../../../db/schema";
import {
  badRequest,
  forbidden,
  internalError,
  throwHttpError,
} from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type { AccessRequestView } from "../../../schemas/access-requests";
import {
  isRequestableResourceType,
  type SharingResourceType,
} from "../../../schemas/access-sharing";
import { recordAccessEvent } from "../record-event";
import { notifyAccessRequested } from "./notify";
import { buildRequestViews } from "./views";

/**
 * Ask for more access to a resource: what "Request access" sends from a
 * refusal or a read-only share dialog.
 *
 * Only for a resource the person can see: one they cannot answers 404 like
 * any other, so a request never tells anyone it exists. Nor for a level the
 * resource never gives them, whatever is shared (`levelCeiling`): no answer
 * could give it. Asking again while
 * the first request waits updates it — the level and the note — rather than
 * piling up requests (`access_requests_pending_resource_uidx`). A guest
 * receives what is shared with them and does not ask.
 *
 * The people who can answer (full access) are emailed once it is saved.
 */
export const requestAccess = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
  level: AccessLevel;
  message?: string | undefined;
}): Promise<AccessRequestView> => {
  const { principal, type, id, level } = input;
  const { node, level: current } = await requireAccess({
    principal,
    type,
    id,
    required: "view",
  });
  if (principal.isGuest) {
    return throwHttpError(
      403,
      forbidden("Guests can't ask for more access to a shared item."),
    );
  }
  if (!isRequestableResourceType(type)) {
    return throwHttpError(
      400,
      badRequest(
        "A collection is shared with teams, not with one person: ask its team's leads to share it with yours.",
      ),
    );
  }
  if (!adapterFor(type).offeredLevels.includes(level)) {
    return throwHttpError(
      400,
      badRequest(`A ${type} can't be shared at ${level} access.`),
    );
  }
  if (atLeast(current, level)) {
    return throwHttpError(400, badRequest("You already have this access."));
  }
  // No answer could give it: the resource stops below it for this person.
  if (!atLeast(levelCeiling(principal, node), level)) {
    return throwResourceRefusal({
      principal,
      resource: node,
      required: level,
      current,
      reason: "LEVEL_CAP",
    });
  }

  const message = input.message?.trim() ? input.message.trim() : null;
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(accessRequests)
      .values({
        organizationId: principal.organizationId,
        requesterUserId: principal.userId,
        resourceType: type,
        resourceId: id,
        requestedLevel: level,
        message,
      })
      .onConflictDoUpdate({
        target: [
          accessRequests.requesterUserId,
          accessRequests.resourceType,
          accessRequests.resourceId,
        ],
        targetWhere: sql`status = 'pending' AND resource_id IS NOT NULL`,
        set: { requestedLevel: level, message },
      })
      .returning();
    if (!row) return throwHttpError(500, internalError());
    await recordAccessEvent({
      executor: tx,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: "request.created",
      resource: { type, id },
      principal: { type: "user", id: principal.userId },
      metadata: { level, resourceName: node.name },
    });
    return row;
  });

  const [view] = await buildRequestViews([saved], new Map([[id, node]]));
  if (!view) return throwHttpError(500, internalError());
  await notifyAccessRequested({
    request: saved,
    resource: { type, node },
    requesterName: view.requester.name,
    level,
  });
  return view;
};
