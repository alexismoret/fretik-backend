import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { resolveAccessMany } from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import db from "../../../db";
import { type AccessRequest, accessRequests } from "../../../db/schema";
import type {
  AccessRequestList,
  AccessRequestView,
} from "../../../schemas/access-requests";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { buildRequestViews, requestedResource } from "./views";

/** More than a screen of requests is a backlog, not an inbox. */
const MAX_LISTED = 200;

/**
 * The pending requests this person may answer — those on a resource they
 * hold full access to, whoever asked — and their own pending requests.
 *
 * Whether they may answer is the engine's answer on each resource, not a
 * role: an admin who cannot open a restricted file does not decide who may.
 */
export const listAccessRequests = async (
  principal: UserPrincipal,
): Promise<AccessRequestList> => {
  const [pending, mine] = await Promise.all([
    principal.isGuest
      ? Promise.resolve([])
      : db
          .select()
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.organizationId, principal.organizationId),
              eq(accessRequests.status, "pending"),
              isNotNull(accessRequests.resourceId),
              ne(accessRequests.requesterUserId, principal.userId),
            ),
          )
          .orderBy(desc(accessRequests.createdAt))
          .limit(MAX_LISTED),
    db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.organizationId, principal.organizationId),
          eq(accessRequests.status, "pending"),
          eq(accessRequests.requesterUserId, principal.userId),
        ),
      )
      .orderBy(desc(accessRequests.createdAt))
      .limit(MAX_LISTED),
  ]);

  return {
    toDecide: await buildRequestViews(await answerable(principal, pending)),
    mine: await buildRequestViews(mine),
  };
};

/** The pending requests on this one resource, for its share dialog. */
export const listResourceRequests = async (input: {
  organizationId: string;
  type: SharingResourceType;
  id: string;
}): Promise<AccessRequestView[]> =>
  buildRequestViews(
    await db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.organizationId, input.organizationId),
          eq(accessRequests.status, "pending"),
          eq(accessRequests.resourceType, input.type),
          eq(accessRequests.resourceId, input.id),
        ),
      )
      .orderBy(desc(accessRequests.createdAt))
      .limit(MAX_LISTED),
  );

/** The requests whose resource this person holds full access to. */
const answerable = async (
  principal: UserPrincipal,
  requests: readonly AccessRequest[],
): Promise<AccessRequest[]> => {
  const idsByType = new Map<SharingResourceType, string[]>();
  for (const request of requests) {
    const resource = requestedResource(request);
    if (resource === null) continue;
    idsByType.set(resource.type, [
      ...(idsByType.get(resource.type) ?? []),
      resource.id,
    ]);
  }
  const full = new Set<string>();
  for (const [type, ids] of idsByType) {
    // oxlint-disable-next-line no-await-in-loop -- one read per type, four at most
    for (const [id, resolved] of await resolveAccessMany(
      principal,
      type,
      ids,
    )) {
      if (resolved.level === "full") full.add(id);
    }
  }
  return requests.filter(
    (request) => request.resourceId !== null && full.has(request.resourceId),
  );
};
