import { inArray } from "drizzle-orm";
import { adapterFor } from "../../../authz/access";
import { loadPrincipal } from "../../../authz/load-principal";
import type { LoadedNode } from "../../../authz/resources/types";
import { computeLevel } from "../../../authz/rules";
import db from "../../../db";
import { type AccessRequest, user } from "../../../db/schema";
import type { AccessRequestView } from "../../../schemas/access-requests";
import {
  type SharingResourceType,
  sharingResourceTypeSchema,
} from "../../../schemas/access-sharing";

/**
 * Requests as the app shows them: the resource by name, who asked, what they
 * have now and what they asked for, who decided.
 *
 * A request for a resource that is gone, or of a type the sharing routes do
 * not handle, is left out: there is nothing left to decide.
 */

/** The resource a request is about, when it is one the sharing routes handle. */
export const requestedResource = (
  request: Pick<AccessRequest, "resourceType" | "resourceId">,
): { type: SharingResourceType; id: string } | null => {
  const type = sharingResourceTypeSchema.safeParse(request.resourceType);
  return type.success && request.resourceId !== null
    ? { type: type.data, id: request.resourceId }
    : null;
};

/** The nodes of these requests' resources, keyed by resource id. */
export const loadRequestedNodes = async (
  requests: readonly AccessRequest[],
): Promise<Map<string, LoadedNode>> => {
  const idsByType = new Map<SharingResourceType, string[]>();
  for (const request of requests) {
    const resource = requestedResource(request);
    if (resource === null) continue;
    idsByType.set(resource.type, [
      ...(idsByType.get(resource.type) ?? []),
      resource.id,
    ]);
  }
  const nodes = new Map<string, LoadedNode>();
  for (const [type, ids] of idsByType) {
    // oxlint-disable-next-line no-await-in-loop -- one read per type, four at most
    for (const [id, node] of await adapterFor(type).loadNodes(ids)) {
      nodes.set(id, node);
    }
  }
  return nodes;
};

export const buildRequestViews = async (
  requests: readonly AccessRequest[],
  known?: ReadonlyMap<string, LoadedNode>,
): Promise<AccessRequestView[]> => {
  const nodes = new Map(known ?? []);
  const missing = requests.filter(
    (request) => request.resourceId !== null && !nodes.has(request.resourceId),
  );
  for (const [id, node] of await loadRequestedNodes(missing)) {
    nodes.set(id, node);
  }

  const people = new Map(
    (
      await db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        })
        .from(user)
        .where(
          inArray(user.id, [
            ...new Set(
              requests.flatMap((request) => [
                request.requesterUserId,
                ...(request.decidedByUserId === null
                  ? []
                  : [request.decidedByUserId]),
              ]),
            ),
          ]),
        )
    ).map((person) => [person.id, person]),
  );

  // What each requester has now, by the engine: one principal per person.
  const principals = new Map(
    await Promise.all(
      [...new Set(requests.map((request) => request.requesterUserId))].map(
        async (userId) => {
          const organizationId = requests.find(
            (request) => request.requesterUserId === userId,
          )?.organizationId;
          const principal =
            organizationId === undefined
              ? null
              : await loadPrincipal({ organizationId, userId });
          return [userId, principal] as const;
        },
      ),
    ),
  );

  return requests.flatMap((request): AccessRequestView[] => {
    const resource = requestedResource(request);
    const node = resource === null ? undefined : nodes.get(resource.id);
    const requester = people.get(request.requesterUserId);
    if (
      resource === null ||
      node === undefined ||
      requester === undefined ||
      request.requestedLevel === null
    ) {
      return [];
    }
    const principal = principals.get(request.requesterUserId) ?? null;
    const decider =
      request.decidedByUserId === null
        ? undefined
        : people.get(request.decidedByUserId);
    return [
      {
        id: request.id,
        resource: { ...resource, name: node.name },
        requester: {
          userId: requester.id,
          name: requester.name,
          email: requester.email,
          image: requester.image,
        },
        level: request.requestedLevel,
        currentLevel: principal === null ? null : computeLevel(principal, node),
        message: request.message,
        status: request.status,
        createdAt: request.createdAt,
        decidedAt: request.decidedAt,
        decidedBy:
          decider === undefined
            ? null
            : { userId: decider.id, name: decider.name },
      },
    ];
  });
};
