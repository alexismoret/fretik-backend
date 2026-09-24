import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../../../db";
import { type AccessRequest, accessRequests } from "../../../db/schema";
import type { AccessLevel } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";
import { recordAccessEvents } from "../record-event";

/**
 * Close the pending requests a grant has just answered: people who asked for
 * this resource at no more than the level they now hold explicitly. Sharing
 * with someone who asked IS the answer, whichever door it came through — the
 * request, the share dialog, a level changed in the list.
 *
 * Runs in the transaction of the grant, and returns what it closed so the
 * caller can tell the requesters once it commits.
 */
export const settleRequestsAnsweredBy = async (
  executor: Executor,
  input: {
    organizationId: string;
    resource: { type: SharingResourceType; id: string; name: string };
    userIds: readonly string[];
    level: AccessLevel;
    deciderUserId: string;
  },
): Promise<AccessRequest[]> => {
  if (input.userIds.length === 0) return [];
  const settled = await executor
    .update(accessRequests)
    .set({
      status: "approved",
      decidedByUserId: input.deciderUserId,
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(accessRequests.organizationId, input.organizationId),
        eq(accessRequests.resourceType, input.resource.type),
        eq(accessRequests.resourceId, input.resource.id),
        eq(accessRequests.status, "pending"),
        inArray(accessRequests.requesterUserId, [...input.userIds]),
        // `access_level` is ordered view < use < edit < full.
        sql`${accessRequests.requestedLevel} <= ${input.level}::access_level`,
      ),
    )
    .returning();
  await recordAccessEvents(
    executor,
    settled.map((request) => ({
      organizationId: input.organizationId,
      actorUserId: input.deciderUserId,
      action: "request.decided",
      resource: { type: input.resource.type, id: input.resource.id },
      principal: { type: "user", id: request.requesterUserId },
      metadata: {
        decision: "approved",
        level: input.level,
        requestedLevel: request.requestedLevel,
        resourceName: input.resource.name,
      },
    })),
  );
  return settled;
};
