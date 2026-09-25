import { and, count, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import { invitation, member } from "../../db/schema";
import { MAX_PEOPLE_PER_ORGANIZATION } from "../../lib/auth-constants";

/**
 * The number Better Auth compares an organization's members with when
 * someone accepts an invitation into it (`membershipLimit`, `lib/auth.ts`).
 *
 * The limit is on people (`MAX_PEOPLE_PER_ORGANIZATION`), while Better Auth
 * counts every member row, two kinds of which take no seat: the teams'
 * agents, one per team, and the guests, who see only what is shared with
 * them. So the number it compares with is raised by as many of those as the
 * organization holds, and an address a guest's invitation waits for is not
 * held to it at all.
 */
export const membershipLimitFor = async (input: {
  organizationId: string;
  email: string;
}): Promise<number> => {
  const [guestInvitations, seatless] = await Promise.all([
    db
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, input.organizationId),
          eq(sql`lower(${invitation.email})`, input.email.trim().toLowerCase()),
          eq(invitation.status, "pending"),
          eq(invitation.role, "guest"),
        ),
      )
      .limit(1),
    db
      .select({ count: count() })
      .from(member)
      .where(
        and(
          eq(member.organizationId, input.organizationId),
          inArray(member.role, ["guest", "bot"]),
        ),
      ),
  ]);
  if (guestInvitations.length > 0) return Number.POSITIVE_INFINITY;
  return MAX_PEOPLE_PER_ORGANIZATION + (seatless[0]?.count ?? 0);
};
