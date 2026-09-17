import { and, eq, sql } from "drizzle-orm";

import db from "../../db";
import { member, user } from "../../db/schema";

export interface OrganizationMemberByEmail {
  memberId: string;
  userId: string;
  role: string;
  email: string;
}

/**
 * The organization membership held by the account behind an email address, or
 * `null` when no account exists or that account is not a member.
 *
 * Mirrors Better Auth's own `findMemberByEmail` (user lookup by lowercased
 * email, then `member` by `(organizationId, userId)`) because the team
 * invitation path has to answer the SAME question the organization plugin
 * answers before it refuses an invitation — "is this address already inside
 * the organization?" — and then take the opposite branch.
 *
 * `user.email` is stored as entered, so the comparison is explicitly
 * case-insensitive rather than relying on the caller having normalized it.
 */
export const findOrganizationMemberByEmail = async (params: {
  organizationId: string;
  email: string;
}): Promise<OrganizationMemberByEmail | null> => {
  const normalized = params.email.trim().toLowerCase();
  if (!normalized) return null;

  const rows = await db
    .select({
      memberId: member.id,
      userId: member.userId,
      role: member.role,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(sql`lower(${user.email})`, normalized),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
};
