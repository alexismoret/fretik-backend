import { and, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  resolveAccessMany,
  type ResolvedResource,
} from "../../../authz/access";
import type { UserPrincipal } from "../../../authz/principal";
import { grantPrincipalMatch } from "../../../authz/sql";
import db from "../../../db";
import {
  accessGrants,
  documents,
  pages,
  team,
  user,
  workflows,
} from "../../../db/schema";
import {
  SHARING_RESOURCE_TYPES,
  type SharingResourceType,
  sharingResourceTypeSchema,
} from "../../../schemas/access-sharing";
import type {
  SharedItem,
  SharedVia,
  SharedWithMe,
} from "../../../schemas/shared-with-me";

/**
 * What others have shared with this person, where they find it again: the
 * folders, documents, pages, workflows and chats shared with them by name — and
 * those shared with a team or project they are in, or with the whole
 * organization, from a team they are not part of. What sits in one of their
 * own teams, they browse to there; what they own, or shared themselves, is
 * not "shared with" them.
 *
 * Each item is what the engine says now: one they can no longer see is left
 * out, and the level is theirs today, whatever the share said.
 */

/** A share reads as the most personal of the grants that reach the person. */
const VIA_ORDER: readonly SharedVia[] = [
  "user",
  "project",
  "team",
  "organization",
];

/** The most recent shares are the ones looked for; older ones stay reachable. */
const MAX_LISTED = 200;
/** Grants read to fill the list: several may reach one item. */
const MAX_GRANTS_READ = 1000;

interface Share {
  readonly type: SharingResourceType;
  readonly id: string;
  readonly via: SharedVia;
  readonly sharedBy: { userId: string; name: string } | null;
  readonly sharedAt: Date;
}

export const listSharedWithMe = async (
  principal: UserPrincipal,
): Promise<SharedWithMe> => {
  const shares = await sharesReaching(principal);
  const resolved = await resolveShares(principal, shares);

  const kept = shares.flatMap((share) => {
    const resource = resolved.get(share.id);
    if (resource === undefined) return [];
    const { node } = resource;
    if (node.ownerUserId === principal.userId || node.teamId === null) {
      return [];
    }
    // A group's share of something in one of the person's own teams is found
    // there, in the team's own lists.
    if (share.via !== "user" && principal.teamRoles.has(node.teamId)) {
      return [];
    }
    return [{ share, resource, teamId: node.teamId }];
  });

  const [details, teamNames] = await Promise.all([
    loadDetails(kept.map(({ share }) => share)),
    loadTeamNames(kept.map(({ teamId }) => teamId)),
  ]);

  const items = kept.flatMap(({ share, resource, teamId }): SharedItem[] => {
    const detail = details.get(share.id);
    if (detail === undefined || detail.archived) return [];
    return [
      {
        resource: {
          type: share.type,
          id: share.id,
          name: resource.node.name,
          teamId,
          teamName: teamNames.get(teamId) ?? null,
        },
        level: resource.level,
        via: share.via,
        sharedBy: share.sharedBy,
        sharedAt: share.sharedAt,
        mimeType: detail.mimeType,
      },
    ];
  });

  return { items: items.slice(0, MAX_LISTED) };
};

/**
 * The grants that reach the person, one share per item: the most personal
 * grant says how it reached them, newest first. Their own grants — the one a
 * person keeps when they restrict someone else's item — are not shares.
 */
const sharesReaching = async (principal: UserPrincipal): Promise<Share[]> => {
  const g = alias(accessGrants, "g");
  const rows = await db
    .select({
      resourceType: g.resourceType,
      resourceId: g.resourceId,
      principalType: g.principalType,
      grantedByUserId: g.grantedByUserId,
      grantedByName: user.name,
      sharedAt: g.createdAt,
    })
    .from(g)
    .leftJoin(user, eq(user.id, g.grantedByUserId))
    .where(
      and(
        eq(g.organizationId, principal.organizationId),
        inArray(g.resourceType, [...SHARING_RESOURCE_TYPES]),
        ne(g.principalType, "invitation"),
        or(isNull(g.expiresAt), gt(g.expiresAt, new Date())),
        or(isNull(g.grantedByUserId), ne(g.grantedByUserId, principal.userId)),
        grantPrincipalMatch(principal, "view"),
      ),
    )
    .orderBy(desc(g.createdAt))
    .limit(MAX_GRANTS_READ);

  const byItem = new Map<string, Share>();
  for (const row of rows) {
    const type = sharingResourceTypeSchema.safeParse(row.resourceType);
    if (!type.success || row.principalType === "invitation") continue;
    const share: Share = {
      type: type.data,
      id: row.resourceId,
      via: row.principalType,
      sharedBy:
        row.grantedByUserId === null || row.grantedByName === null
          ? null
          : { userId: row.grantedByUserId, name: row.grantedByName },
      sharedAt: row.sharedAt,
    };
    const known = byItem.get(share.id);
    if (
      known === undefined ||
      VIA_ORDER.indexOf(share.via) < VIA_ORDER.indexOf(known.via)
    ) {
      byItem.set(share.id, share);
    }
  }
  return [...byItem.values()].sort(
    (a, b) => b.sharedAt.getTime() - a.sharedAt.getTime(),
  );
};

/** Each shared item as the engine sees it for the person, by id. */
const resolveShares = async (
  principal: UserPrincipal,
  shares: readonly Share[],
): Promise<Map<string, ResolvedResource>> => {
  const resolved = new Map<string, ResolvedResource>();
  for (const type of SHARING_RESOURCE_TYPES) {
    const ids = shares
      .filter((share) => share.type === type)
      .map((share) => share.id);
    if (ids.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- one read per type, four at most
    for (const [id, resource] of await resolveAccessMany(
      principal,
      type,
      ids,
    )) {
      resolved.set(id, resource);
    }
  }
  return resolved;
};

interface Detail {
  readonly mimeType: string | null;
  /** An archived page or workflow is in no list, this one included. */
  readonly archived: boolean;
}

/** What a list shows beyond the engine's node: a file's type, an archive. */
const loadDetails = async (
  shares: readonly Share[],
): Promise<Map<string, Detail>> => {
  const idsOf = (type: SharingResourceType) =>
    shares.filter((share) => share.type === type).map((share) => share.id);
  const [documentIds, pageIds, workflowIds] = [
    idsOf("document"),
    idsOf("page"),
    idsOf("workflow"),
  ];

  const [documentRows, pageRows, workflowRows] = await Promise.all([
    documentIds.length === 0
      ? []
      : db
          .select({ id: documents.id, mimeType: documents.mimeType })
          .from(documents)
          .where(inArray(documents.id, documentIds)),
    pageIds.length === 0
      ? []
      : db
          .select({ id: pages.id, archivedAt: pages.archivedAt })
          .from(pages)
          .where(inArray(pages.id, pageIds)),
    workflowIds.length === 0
      ? []
      : db
          .select({ id: workflows.id, status: workflows.status })
          .from(workflows)
          .where(inArray(workflows.id, workflowIds)),
  ]);

  const details = new Map<string, Detail>();
  for (const share of shares) {
    // Folders and chats carry nothing beyond their node.
    if (share.type === "folder" || share.type === "conversation") {
      details.set(share.id, { mimeType: null, archived: false });
    }
  }
  for (const row of documentRows) {
    details.set(row.id, { mimeType: row.mimeType, archived: false });
  }
  for (const row of pageRows) {
    details.set(row.id, { mimeType: null, archived: row.archivedAt !== null });
  }
  for (const row of workflowRows) {
    details.set(row.id, {
      mimeType: null,
      archived: row.status === "archived",
    });
  }
  return details;
};

const loadTeamNames = async (
  teamIds: readonly string[],
): Promise<Map<string, string>> => {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: team.id, name: team.name })
    .from(team)
    .where(inArray(team.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
};
