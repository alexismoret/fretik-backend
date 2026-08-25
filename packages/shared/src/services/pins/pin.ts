import { and, count, eq, sql } from "drizzle-orm";
import db from "../../db";
import { userPins } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import { MAX_PINS_PER_USER_TEAM, type PinTarget } from "../../schemas/pins";
import { listCollections } from "../collections/retrieve";
import { getPage } from "../pages/retrieve";
import type { PageRequester } from "../pages/visibility";
import { getWorkflowRow } from "../workflows/get";

/**
 * Pin one target to the caller's sidebar, in the team they are working in.
 *
 * The target is resolved through the SAME read the caller would use to open it
 * — `getPage` for a page, `getWorkflowRow` for a workflow, the team's visible
 * collection list for a collection — so pinning can never be used to probe for
 * a private page, a private workflow or a collection another team owns: an
 * invisible target answers 404, exactly like opening it would.
 *
 * Idempotent: the natural key is the primary key, so re-pinning is a no-op that
 * preserves the original position rather than moving the entry to the end.
 */
export const pinTarget = async (params: {
  userId: string;
  organizationId: string;
  teamId: string;
  target: PinTarget;
  requester?: PageRequester;
}): Promise<void> => {
  if (params.target.targetType === "page") {
    await getPage({
      pageId: params.target.targetId,
      teamId: params.teamId,
      ...(params.requester ? { requester: params.requester } : {}),
    });
  } else if (params.target.targetType === "workflow") {
    const workflow = await getWorkflowRow({
      id: params.target.targetId,
      teamId: params.teamId,
      ...(params.requester ? { requester: params.requester } : {}),
    });
    if (!workflow) {
      return throwHttpError(404, notFound("Workflow"));
    }
  } else {
    const visible = await listCollections({
      organizationId: params.organizationId,
      teamId: params.teamId,
      includeDisabled: false,
    });
    if (!visible.some((c) => c.id === params.target.targetId)) {
      return throwHttpError(404, notFound("Collection"));
    }
  }

  const [pinned] = await db
    .select({ value: count() })
    .from(userPins)
    .where(
      and(
        eq(userPins.userId, params.userId),
        eq(userPins.teamId, params.teamId),
      ),
    );
  if ((pinned?.value ?? 0) >= MAX_PINS_PER_USER_TEAM) {
    return throwHttpError(400, {
      code: "PIN_LIMIT_REACHED",
      message: `You can pin at most ${MAX_PINS_PER_USER_TEAM} items per team. Unpin something first.`,
    });
  }

  await db
    .insert(userPins)
    .values({
      userId: params.userId,
      organizationId: params.organizationId,
      teamId: params.teamId,
      targetType: params.target.targetType,
      targetId: params.target.targetId,
      // Appended in the statement itself, not read-then-written: two pins
      // racing from two tabs must not compute the same slot from the same
      // stale MAX.
      displayOrder: sql`(SELECT COALESCE(MAX(${userPins.displayOrder}), -1) + 1 FROM ${userPins} WHERE ${userPins.userId} = ${params.userId} AND ${userPins.teamId} = ${params.teamId})`,
    })
    .onConflictDoNothing();
};
