import { and, eq, exists, gt, isNull, lte, notExists, or } from "drizzle-orm";
import db from "../../../db";
import { accessGrants, member, user } from "../../../db/schema";
import { onMemberLeftOrganization } from "../../../lib/auth-membership";
import { organizationAdapter } from "../../../lib/org-adapter";
import { recordAccessEvent } from "../record-event";

/** Why a guest left, as the journal records it (`member.removed`). */
export const GUEST_ACCESS_ENDED = "access.ended";

/** Guests removed per pass; the next pass takes whoever is left. */
const BATCH = 200;

/**
 * Guests whose access has ended leave the organization.
 *
 * A guest holds what is shared with them for the organization's period
 * (`guestAccessDays`). Once every share has run out, nothing is left for them
 * to open, and nothing should be left of them in it either: a member counted,
 * listed and offered in a picker, and the owner of what they made while they
 * took part. So they are removed the way an admin removes someone: through
 * Better Auth's adapter, journaled (`member.removed`, with the reason), and
 * followed by what any departure is. Sharing with them again is a new
 * invitation, which an existing account accepts from the app.
 *
 * Only a guest whose access ENDED: one whose shares were all withdrawn by
 * hand stays until an admin removes them, and one with a share still running
 * stays, whatever else ran out.
 */
export const removeExpiredGuests = async (
  now: Date = new Date(),
): Promise<{ removed: number }> => {
  const theirGrants = (
    organizationId: typeof member.organizationId,
    userId: typeof member.userId,
  ) =>
    and(
      eq(accessGrants.organizationId, organizationId),
      eq(accessGrants.principalType, "user"),
      eq(accessGrants.principalId, userId),
    );

  const ended = await db
    .select({
      memberId: member.id,
      organizationId: member.organizationId,
      userId: member.userId,
      name: user.name,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.role, "guest"),
        // Something of theirs ran out...
        exists(
          db
            .select({ id: accessGrants.id })
            .from(accessGrants)
            .where(
              and(
                theirGrants(member.organizationId, member.userId),
                lte(accessGrants.expiresAt, now),
              ),
            ),
        ),
        // ...and nothing is still running.
        notExists(
          db
            .select({ id: accessGrants.id })
            .from(accessGrants)
            .where(
              and(
                theirGrants(member.organizationId, member.userId),
                or(
                  isNull(accessGrants.expiresAt),
                  gt(accessGrants.expiresAt, now),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(BATCH);

  const adapter = await organizationAdapter();
  // One at a time, like an admin's removals: each is its own departure.
  /* oxlint-disable no-await-in-loop -- each departure runs its own lifecycle */
  for (const guest of ended) {
    await adapter.deleteMember({
      memberId: guest.memberId,
      organizationId: guest.organizationId,
      userId: guest.userId,
    });
    await recordAccessEvent({
      organizationId: guest.organizationId,
      actorUserId: null,
      action: "member.removed",
      principal: { type: "user", id: guest.userId },
      metadata: {
        userName: guest.name,
        email: guest.email,
        role: "guest",
        reason: GUEST_ACCESS_ENDED,
      },
    });
    await onMemberLeftOrganization({
      organizationId: guest.organizationId,
      userId: guest.userId,
    });
  }
  /* oxlint-enable no-await-in-loop */
  return { removed: ended.length };
};
