import { and, eq } from "drizzle-orm";

import db from "../../db";
import { member } from "../../db/schema";

/**
 * The current user's role within an organization (`owner` / `admin` /
 * `member` / `bot`), or `null` if they are not a member. Used to gate
 * admin-only endpoints (e.g. organization logo / settings).
 */
export const getOrgMemberRole = async (
  organizationId: string,
  userId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);

  return rows[0]?.role ?? null;
};

/** True when the user can administer the organization. */
export const isOrgAdmin = async (
  organizationId: string,
  userId: string,
): Promise<boolean> => {
  const role = await getOrgMemberRole(organizationId, userId);
  return role === "owner" || role === "admin";
};
