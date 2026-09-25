import { and, eq, sql } from "drizzle-orm";
import { parseOrganizationRole } from "../../authz/load-principal";
import db, { type Executor } from "../../db";
import { member, user } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";
import type { OrganizationRole } from "../../schemas/access";

/** One person's membership of an organization. */
export interface Membership {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: Exclude<OrganizationRole, "bot">;
}

/**
 * A person's membership, or 404. Someone of another organization and a team
 * agent's account answer alike: neither is a person of this one to manage.
 */
export const findMembership = async (
  organizationId: string,
  userId: string,
): Promise<Membership> => {
  const [row] = await db
    .select({
      memberId: member.id,
      userId: member.userId,
      role: member.role,
      name: user.name,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  const role = row === undefined ? null : parseOrganizationRole(row.role);
  if (row === undefined || role === null || role === "bot") {
    return throwHttpError(404, notFound("Member not found"));
  }
  return { ...row, role };
};

/**
 * The organization's owners, LOCKED until the transaction ends. Two owners
 * demoting each other at once must not both succeed: the second waits on the
 * first's lock, then re-reads a set the first has already shrunk.
 */
export const lockOwners = async (
  tx: Executor,
  organizationId: string,
): Promise<string[]> => {
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        sql`'owner' = any(string_to_array(${member.role}, ','))`,
      ),
    )
    .for("update");
  return rows.map((row) => row.userId);
};
