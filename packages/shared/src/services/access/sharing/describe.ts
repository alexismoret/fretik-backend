import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { adapterFor, requireAccess } from "../../../authz/access";
import { decideCapability } from "../../../authz/capabilities";
import { levelRank } from "../../../authz/levels";
import type { UserPrincipal } from "../../../authz/principal";
import type { LoadedNode } from "../../../authz/resources/types";
import { ceilingFor, inheritedCap } from "../../../authz/rules";
import db from "../../../db";
import {
  accessGrants,
  aiConversationMembers,
  projects,
  team,
  user,
} from "../../../db/schema";
import type {
  AccessHolder,
  InheritanceSource,
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { getOrganizationAccessPolicy } from "../../organization/access-policy";
import { listResourceRequests } from "../requests/list-requests";
import { principalKey, resolvePrincipals } from "./principals";

/**
 * The share dialog's model of one resource: its owner, who else holds a
 * grant and at what level, what it inherits from while it is open, and the
 * organization's sharing policy as it applies to the caller.
 *
 * Everyone who can see the resource reads it (`view`), as in every shared
 * drive: knowing who else has access is part of knowing what one is looking
 * at. A guest sees only their own grant: the organization's people are not
 * theirs to list. The pending requests for more access are shown to whoever
 * may answer them, and to no one else.
 */
export const describeResourceAccess = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
}): Promise<ResourceAccess> => {
  const { principal, type, id } = input;
  const { node, level } = await requireAccess({
    principal,
    type,
    id,
    required: "view",
  });
  const adapter = adapterFor(type);
  const canManage = level === "full" && !principal.isGuest;

  const [holders, owner, inheritsFrom, policy, requests] = await Promise.all([
    loadHolders(principal, type, node),
    loadOwner(node.ownerUserId),
    inheritanceSourceOf(node),
    getOrganizationAccessPolicy(principal.organizationId),
    canManage
      ? listResourceRequests({
          organizationId: principal.organizationId,
          type,
          id,
        })
      : [],
  ]);

  return {
    resource: { type, id, name: node.name, teamId: node.teamId },
    level,
    canManage,
    owner,
    holders: principal.isGuest
      ? holders.filter(
          (holder) =>
            holder.principalType === "user" &&
            holder.principalId === principal.userId,
        )
      : holders,
    general: {
      restricted: node.restricted,
      inheritsFrom,
      ownerRestrictsOnly: type === "workflow",
      inheritedLevel: inheritedCap(type),
    },
    offeredLevels: [...adapter.offeredLevels],
    groupLevels: [...(adapter.groupLevels ?? adapter.offeredLevels)],
    // Nobody picked is its owner: the owner is never given anything.
    ceilings: {
      team: ceilingFor(node, { isOwner: false, inTeam: true }),
      outsider: ceilingFor(node, { isOwner: false, inTeam: false }),
    },
    shareablePrincipals: [...adapter.shareablePrincipals],
    policy: {
      crossTeam: decideCapability({
        principal,
        capability: "share.cross_team",
        policy,
      }),
      organization: decideCapability({
        principal,
        capability: "share.organization",
        policy,
      }),
    },
    requests,
  };
};

/** The explicit grants, made readable, strongest first, then by name. */
const loadHolders = async (
  principal: UserPrincipal,
  type: SharingResourceType,
  node: LoadedNode,
): Promise<AccessHolder[]> => {
  const rows = await db
    .select({
      principalType: accessGrants.principalType,
      principalId: accessGrants.principalId,
      level: accessGrants.level,
      grantedAt: accessGrants.createdAt,
      grantedByUserId: accessGrants.grantedByUserId,
      grantedByName: user.name,
    })
    .from(accessGrants)
    .leftJoin(user, eq(user.id, accessGrants.grantedByUserId))
    .where(
      and(
        eq(accessGrants.resourceType, type),
        eq(accessGrants.resourceId, node.id),
        ne(accessGrants.principalType, "invitation"),
        or(
          isNull(accessGrants.expiresAt),
          gt(accessGrants.expiresAt, new Date()),
        ),
      ),
    );

  // A chat's participants are its seats, listed beside its grants; the owner
  // is the owner, not a holder.
  const seats =
    type === "conversation"
      ? (
          await db
            .select({
              principalId: aiConversationMembers.userId,
              grantedAt: aiConversationMembers.joinedAt,
            })
            .from(aiConversationMembers)
            .where(
              and(
                eq(aiConversationMembers.conversationId, node.id),
                ne(aiConversationMembers.role, "owner"),
              ),
            )
        ).map((seat) => ({
          principalType: "user" as const,
          principalId: seat.principalId,
          level: "use" as const,
          grantedAt: seat.grantedAt,
          grantedByUserId: null,
          grantedByName: null,
        }))
      : [];
  const seated = new Set(seats.map((seat) => seat.principalId));
  const entries = [
    ...rows.filter(
      (row) => !(row.principalType === "user" && seated.has(row.principalId)),
    ),
    ...seats,
  ];

  const refs = entries.flatMap((row) =>
    row.principalType === "invitation"
      ? []
      : [{ type: row.principalType, id: row.principalId }],
  );
  const described = await resolvePrincipals(principal.organizationId, refs);

  const holders = entries.flatMap((row): AccessHolder[] => {
    if (row.principalType === "invitation") return [];
    // A principal that left the organization gets nothing from its grant
    // and is not listed; it counts again if it comes back.
    const who = described.get(
      principalKey({ type: row.principalType, id: row.principalId }),
    );
    if (!who) return [];
    return [
      {
        principalType: who.type,
        principalId: who.id,
        name: who.name,
        email: who.email,
        image: who.image,
        memberCount: who.memberCount,
        level: row.level,
        grantedAt: row.grantedAt,
        grantedBy:
          row.grantedByUserId === null || row.grantedByName === null
            ? null
            : { userId: row.grantedByUserId, name: row.grantedByName },
      },
    ];
  });

  return holders.sort(
    (a, b) =>
      levelRank(b.level) - levelRank(a.level) || a.name.localeCompare(b.name),
  );
};

const loadOwner = async (
  ownerUserId: string | null,
): Promise<ResourceAccess["owner"]> => {
  if (ownerUserId === null) return null;
  const row = await db.query.user.findFirst({
    columns: { id: true, name: true, email: true, image: true },
    where: { id: ownerUserId },
  });
  return row
    ? { userId: row.id, name: row.name, email: row.email, image: row.image }
    : null;
};

/**
 * What an open resource inherits from: the folder it sits in, else its
 * project, else its team — the order `rules.ts` walks.
 */
const inheritanceSourceOf = async (
  node: LoadedNode,
): Promise<InheritanceSource | null> => {
  if (node.parent !== null) {
    return { type: "folder", id: node.parent.id, name: node.parent.name };
  }
  if (node.projectId !== null) {
    const [row] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, node.projectId));
    return row ? { type: "project", id: node.projectId, name: row.name } : null;
  }
  if (node.teamId !== null) {
    const [row] = await db
      .select({ name: team.name })
      .from(team)
      .where(eq(team.id, node.teamId));
    return row ? { type: "team", id: node.teamId, name: row.name } : null;
  }
  return null;
};
