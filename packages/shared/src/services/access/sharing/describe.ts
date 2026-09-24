import { eq } from "drizzle-orm";
import { adapterFor, requireAccess } from "../../../authz/access";
import { decideCapability } from "../../../authz/capabilities";
import { levelRank } from "../../../authz/levels";
import type { UserPrincipal } from "../../../authz/principal";
import { projectParticipants } from "../../../authz/project-people";
import type { LoadedNode } from "../../../authz/resources/types";
import { ceilingFor, inheritedCap } from "../../../authz/rules";
import db from "../../../db";
import { projects, team } from "../../../db/schema";
import type {
  AccessHolder,
  InheritanceSource,
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { getOrganizationAccessPolicy } from "../../organization/access-policy";
import { listResourceRequests } from "../requests/list-requests";
import { listGrants } from "./grant-store";
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

  const [holders, owner, inheritsFrom, policy, requests, insiders] =
    await Promise.all([
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
      insidersOf(type, node),
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
      restrictable: type !== "collection",
      ownerRestrictsOnly: type === "workflow",
      inheritedLevel: inheritedCap(type),
    },
    offeredLevels: [...adapter.offeredLevels],
    groupLevels: [...(adapter.groupLevels ?? adapter.offeredLevels)],
    // Nobody picked is its owner: the owner is never given anything.
    ceilings: {
      team: ceilingFor(node, { isOwner: false, worksThere: true }),
      outsider: ceilingFor(node, { isOwner: false, worksThere: false }),
      insiders,
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
  const grants = await listGrants(db, { type, id: node.id });
  const described = await resolvePrincipals(principal.organizationId, grants);

  const holders = grants.flatMap((grant): AccessHolder[] => {
    // A principal that left the organization gets nothing from its grant
    // and is not listed; it counts again if it comes back.
    const who = described.get(principalKey(grant));
    if (!who) return [];
    return [
      {
        principalType: who.type,
        principalId: who.id,
        name: who.name,
        email: who.email,
        image: who.image,
        memberCount: who.memberCount,
        level: grant.level,
        grantedAt: grant.grantedAt,
        grantedBy: grant.grantedBy,
      },
    ];
  });

  return holders.sort(
    (a, b) =>
      levelRank(b.level) - levelRank(a.level) || a.name.localeCompare(b.name),
  );
};

/**
 * Who works where a chat in a project lives: the project's participants,
 * whatever their team — the only people who can take part in it. Null for
 * everything else, whose insiders are simply the people of its team.
 */
const insidersOf = async (
  type: SharingResourceType,
  node: LoadedNode,
): Promise<string[] | null> => {
  if (type !== "conversation" || node.projectId === null) return null;
  const participants = await projectParticipants({
    organizationId: node.organizationId,
    projectId: node.projectId,
  });
  return [...participants].sort();
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
