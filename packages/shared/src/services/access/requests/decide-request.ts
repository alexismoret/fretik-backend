import { and, eq } from "drizzle-orm";
import { loadPrincipal } from "../../../authz/load-principal";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { type AccessRequest, accessRequests } from "../../../db/schema";
import { internalError, notFound, throwHttpError } from "../../../lib/errors";
import type { AccessLevel, AccessRequestStatus } from "../../../schemas/access";
import type { AccessRequestView } from "../../../schemas/access-requests";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { ERROR_CODES } from "../../../schemas/errors";
import { recordAccessEvent } from "../record-event";
import { requireSharingRights } from "../sharing/manage-rights";
import { shareResource } from "../sharing/share";
import { notifyAccessDecided } from "./notify";
import { buildRequestViews, requestedResource } from "./views";

/**
 * Answer an access request: approve it — at the level asked for, or another
 * one the decider picks — or deny it.
 *
 * Only someone who could share the resource answers (full access, never a
 * guest: `requireSharingRights`), and approving IS sharing: it goes through
 * `shareResource`, with its policy checks, its journal and the assistant's
 * index, and that share closes the request. A request already answered is a
 * conflict; one from someone who has left the organization is withdrawn.
 * The requester is emailed the answer.
 */
export const decideAccessRequest = async (input: {
  principal: UserPrincipal;
  requestId: string;
  decision: "approve" | "deny";
  level?: AccessLevel | undefined;
}): Promise<AccessRequestView> => {
  const { principal } = input;
  const request = await db.query.accessRequests.findFirst({
    where: { id: input.requestId, organizationId: principal.organizationId },
  });
  const resource = request ? requestedResource(request) : null;
  if (!request || resource === null) {
    return throwHttpError(404, notFound("Request not found"));
  }
  if (request.status !== "pending") {
    return throwHttpError(409, {
      code: ERROR_CODES.ACCESS_REQUEST_CLOSED,
      message: "This request was already answered.",
    });
  }
  const { node } = await requireSharingRights({ principal, ...resource });

  const requester = await loadPrincipal({
    organizationId: principal.organizationId,
    userId: request.requesterUserId,
  });
  if (requester === null) {
    await closeRequest({
      request,
      status: "canceled",
      decider: principal,
      resource: { ...resource, name: node.name },
    });
    return throwHttpError(409, {
      code: ERROR_CODES.ACCESS_REQUEST_CLOSED,
      message: "The person who asked is no longer in the organization.",
    });
  }

  const decider = await deciderName(principal.userId);
  if (input.decision === "approve") {
    const level = input.level ?? request.requestedLevel ?? "view";
    // Sharing closes the request when the level reaches what was asked, and
    // tells the requester; a lower level is still an answer, closed here.
    await shareResource({
      principal,
      ...resource,
      principals: [{ type: "user", id: request.requesterUserId }],
      level,
    });
    const closed = await closeRequest({
      request,
      status: "approved",
      decider: principal,
      level,
      resource: { ...resource, name: node.name },
    });
    if (closed) {
      await notifyAccessDecided({
        requests: [request],
        resource: { ...resource, name: node.name },
        decision: "approved",
        level,
        deciderName: decider,
      });
    }
  } else {
    const closed = await closeRequest({
      request,
      status: "denied",
      decider: principal,
      resource: { ...resource, name: node.name },
    });
    if (closed) {
      await notifyAccessDecided({
        requests: [request],
        resource: { ...resource, name: node.name },
        decision: "denied",
        level: null,
        deciderName: decider,
      });
    }
  }

  // Read back as it now stands: the node is loaded again, the grant the
  // answer gave is part of what the requester has.
  const answered = await db.query.accessRequests.findFirst({
    where: { id: request.id },
  });
  const [view] = answered ? await buildRequestViews([answered]) : [];
  return view ?? throwHttpError(500, internalError());
};

/**
 * The requester withdraws their own pending request. Someone else's, or one
 * already answered, reads as missing.
 */
export const cancelAccessRequest = async (input: {
  principal: UserPrincipal;
  requestId: string;
}): Promise<void> => {
  const [canceled] = await db
    .update(accessRequests)
    .set({ status: "canceled" })
    .where(
      and(
        eq(accessRequests.id, input.requestId),
        eq(accessRequests.organizationId, input.principal.organizationId),
        eq(accessRequests.requesterUserId, input.principal.userId),
        eq(accessRequests.status, "pending"),
      ),
    )
    .returning({ id: accessRequests.id });
  if (!canceled) throwHttpError(404, notFound("Request not found"));
};

/**
 * Close a request that is still pending, and journal the answer. False when
 * it was already closed — by the share that answered it, or a concurrent
 * decision — so the answer is told once.
 */
const closeRequest = async (input: {
  request: AccessRequest;
  status: Exclude<AccessRequestStatus, "pending">;
  decider: UserPrincipal;
  level?: AccessLevel;
  resource: { type: SharingResourceType; id: string; name: string };
}): Promise<boolean> =>
  db.transaction(async (tx) => {
    const [closed] = await tx
      .update(accessRequests)
      .set({
        status: input.status,
        decidedByUserId: input.decider.userId,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(accessRequests.id, input.request.id),
          eq(accessRequests.status, "pending"),
        ),
      )
      .returning({ id: accessRequests.id });
    if (!closed) return false;
    await recordAccessEvent({
      executor: tx,
      organizationId: input.request.organizationId,
      actorUserId: input.decider.userId,
      action: "request.decided",
      resource: { type: input.resource.type, id: input.resource.id },
      principal: { type: "user", id: input.request.requesterUserId },
      metadata: {
        decision: input.status,
        requestedLevel: input.request.requestedLevel,
        ...(input.level === undefined ? {} : { level: input.level }),
        resourceName: input.resource.name,
      },
    });
    return true;
  });

const deciderName = async (userId: string): Promise<string> =>
  (
    await db.query.user.findFirst({
      columns: { name: true },
      where: { id: userId },
    })
  )?.name ?? "";
