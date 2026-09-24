import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { adapterFor } from "../../../authz/access";
import { parseOrganizationRole } from "../../../authz/load-principal";
import type { Executor } from "../../../db";
import { accessGrants, invitation, user } from "../../../db/schema";
import type { AccessLevel, OrganizationRole } from "../../../schemas/access";
import type { SharingResourceType } from "../../../schemas/access-sharing";

/**
 * Grants to someone who has not joined yet: an `invitation` grant, keyed by
 * the invitation's id. It gives nothing — the engine reads no `invitation`
 * grant (`authz/resources/grants.ts`) — until the person accepts and it
 * becomes theirs (`accept-invitation.ts`).
 *
 * Always kept in `access_grants`, whatever table the resource keeps its other
 * grants in: a chat's seat is a person's, and there is no person yet. Only a
 * PENDING, unexpired invitation holds anything: one canceled or declined
 * drops its grants (`dropInvitationGrants`); one past its date keeps rows
 * that give nothing and are listed nowhere, and go with it.
 */

interface Resource {
  readonly type: SharingResourceType;
  readonly id: string;
}

/** An address invited onto a resource, as the share dialog lists it. */
export interface InvitationHolder {
  readonly invitationId: string;
  readonly email: string;
  /** The role they will hold in the organization once they accept. */
  readonly role: OrganizationRole;
  readonly level: AccessLevel;
  readonly grantedAt: Date;
  readonly grantedBy: { readonly userId: string; readonly name: string } | null;
  /** When the invitation's link stops working. */
  readonly expiresAt: Date;
}

const isInvitationOf = (resource: Resource, invitationId?: string) =>
  and(
    eq(accessGrants.resourceType, resource.type),
    eq(accessGrants.resourceId, resource.id),
    eq(accessGrants.principalType, "invitation"),
    invitationId === undefined
      ? undefined
      : eq(accessGrants.principalId, invitationId),
  );

const stillPending = () =>
  and(eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date()));

/** The invitations waiting on the resource: pending, not expired. */
export const listInvitationHolders = async (
  executor: Executor,
  resource: Resource,
): Promise<InvitationHolder[]> => {
  const rows = await executor
    .select({
      invitationId: accessGrants.principalId,
      level: accessGrants.level,
      grantedAt: accessGrants.createdAt,
      grantedByUserId: accessGrants.grantedByUserId,
      grantedByName: user.name,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    })
    .from(accessGrants)
    .innerJoin(invitation, eq(invitation.id, accessGrants.principalId))
    .leftJoin(user, eq(user.id, accessGrants.grantedByUserId))
    .where(and(isInvitationOf(resource), stillPending()));
  return rows.map((row) => ({
    invitationId: row.invitationId,
    email: row.email,
    // No role is Better Auth's default: a member.
    role: parseOrganizationRole(row.role ?? "member"),
    level: row.level,
    grantedAt: row.grantedAt,
    grantedBy:
      row.grantedByUserId === null || row.grantedByName === null
        ? null
        : { userId: row.grantedByUserId, name: row.grantedByName },
    expiresAt: row.expiresAt,
  }));
};

/** One invitation's grant on the resource, locked for a change; null if none. */
export const lockInvitationGrant = async (
  tx: Executor,
  resource: Resource,
  invitationId: string,
): Promise<{ readonly level: AccessLevel } | null> => {
  const [row] = await tx
    .select({ level: accessGrants.level })
    .from(accessGrants)
    .where(isInvitationOf(resource, invitationId))
    .for("update");
  return row ?? null;
};

/** Give the invitation `level` on the resource, created or changed. */
export const upsertInvitationGrant = async (
  tx: Executor,
  write: {
    readonly organizationId: string;
    readonly resource: Resource;
    readonly invitationId: string;
    readonly level: AccessLevel;
    readonly actorUserId: string;
  },
): Promise<void> => {
  await tx
    .insert(accessGrants)
    .values({
      organizationId: write.organizationId,
      resourceType: write.resource.type,
      resourceId: write.resource.id,
      principalType: "invitation",
      principalId: write.invitationId,
      level: write.level,
      grantedByUserId: write.actorUserId,
    })
    .onConflictDoUpdate({
      target: [
        accessGrants.resourceType,
        accessGrants.resourceId,
        accessGrants.principalType,
        accessGrants.principalId,
      ],
      set: { level: write.level, grantedByUserId: write.actorUserId },
    });
};

/** Take the invitation's grant on the resource away. */
export const deleteInvitationGrant = async (
  tx: Executor,
  resource: Resource,
  invitationId: string,
): Promise<void> => {
  await tx.delete(accessGrants).where(isInvitationOf(resource, invitationId));
};

/** One grant an invitation holds. */
export interface HeldByInvitation {
  readonly type: SharingResourceType;
  readonly id: string;
  readonly level: AccessLevel;
  readonly grantedByUserId: string | null;
}

/** Every grant an invitation holds, oldest first: what accepting it gives. */
export const grantsOfInvitation = async (
  executor: Executor,
  invitationId: string,
): Promise<HeldByInvitation[]> => {
  const rows = await executor
    .select({
      type: accessGrants.resourceType,
      id: accessGrants.resourceId,
      level: accessGrants.level,
      grantedByUserId: accessGrants.grantedByUserId,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.principalType, "invitation"),
        eq(accessGrants.principalId, invitationId),
      ),
    )
    .orderBy(accessGrants.createdAt);
  // `connection` is never shared with a person, let alone invited onto.
  return rows.flatMap((row) =>
    row.type === "connection" ? [] : [{ ...row, type: row.type }],
  );
};

/** Whether the invitation still holds a grant on anything. */
export const invitationHoldsGrants = async (
  executor: Executor,
  invitationId: string,
): Promise<boolean> => {
  const [row] = await executor
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.principalType, "invitation"),
        eq(accessGrants.principalId, invitationId),
      ),
    );
  return (row?.count ?? 0) > 0;
};

/**
 * Drop every grant of an invitation that will never be accepted — canceled
 * or declined. Answers what was dropped, for the journal.
 */
export const dropInvitationGrants = async (
  executor: Executor,
  invitationId: string,
): Promise<HeldByInvitation[]> => {
  const dropped = await executor
    .delete(accessGrants)
    .where(
      and(
        eq(accessGrants.principalType, "invitation"),
        eq(accessGrants.principalId, invitationId),
      ),
    )
    .returning({
      type: accessGrants.resourceType,
      id: accessGrants.resourceId,
      level: accessGrants.level,
      grantedByUserId: accessGrants.grantedByUserId,
    });
  return dropped.flatMap((row) =>
    row.type === "connection" ? [] : [{ ...row, type: row.type }],
  );
};

/** An item an invitation gives, as the invitation page and the Members page name it. */
export interface InvitationItemView {
  readonly type: SharingResourceType;
  readonly id: string;
  readonly name: string;
  readonly level: AccessLevel;
}

/**
 * What each of these invitations gives, named, oldest share first. An item
 * that no longer exists is left out; its grant went with it.
 */
export const describeInvitationItems = async (
  executor: Executor,
  invitationIds: readonly string[],
): Promise<Map<string, InvitationItemView[]>> => {
  const byInvitation = new Map<string, InvitationItemView[]>();
  if (invitationIds.length === 0) return byInvitation;
  const rows = await executor
    .select({
      invitationId: accessGrants.principalId,
      type: accessGrants.resourceType,
      id: accessGrants.resourceId,
      level: accessGrants.level,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.principalType, "invitation"),
        inArray(accessGrants.principalId, [...new Set(invitationIds)]),
      ),
    )
    .orderBy(accessGrants.createdAt);

  const idsByType = new Map<SharingResourceType, string[]>();
  for (const row of rows) {
    if (row.type === "connection") continue;
    idsByType.set(row.type, [...(idsByType.get(row.type) ?? []), row.id]);
  }
  const names = new Map<string, string>();
  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      const nodes = await adapterFor(type).loadNodes(ids, executor);
      for (const node of nodes.values()) {
        names.set(`${type}:${node.id}`, node.name);
      }
    }),
  );
  for (const row of rows) {
    if (row.type === "connection") continue;
    const name = names.get(`${row.type}:${row.id}`);
    if (name === undefined) continue;
    const items = byInvitation.get(row.invitationId) ?? [];
    items.push({ type: row.type, id: row.id, name, level: row.level });
    byInvitation.set(row.invitationId, items);
  }
  return byInvitation;
};
