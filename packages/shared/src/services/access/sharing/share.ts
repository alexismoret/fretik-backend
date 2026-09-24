import { adapterFor } from "../../../authz/access";
import { requireCapability } from "../../../authz/gates";
import { guestAccessExpiry, guestCeilingFor } from "../../../authz/guests";
import { levelRank } from "../../../authz/levels";
import type { UserPrincipal } from "../../../authz/principal";
import { projectParticipants } from "../../../authz/project-people";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { badRequest, throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type {
  HolderPrincipalType,
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { ERROR_CODES } from "../../../schemas/errors";
import { refreshAclsAfterAccessChange } from "../../ai-vectors/acl";
import { getOrganizationAccessPolicy } from "../../organization/access-policy";
import { tellGuestsShared } from "../guests/tell-guests-shared";
import { type AccessEvent, recordAccessEvents } from "../record-event";
import { tellRequestersAnswered } from "../requests/answered-by-share";
import { settleRequestsAnsweredBy } from "../requests/settle-requests";
import { afterAccessChange } from "./after-change";
import { describeResourceAccess } from "./describe";
import { lockGrants, upsertGrants } from "./grant-store";
import { requireSharingRights } from "./manage-rights";
import {
  type Grantee,
  type PrincipalRef,
  principalKey,
  resolvePrincipals,
} from "./principals";

/**
 * Share a resource with people, teams, projects or the whole organization,
 * at one level — what the share dialog sends when someone picks several at
 * once. A pick that already holds a grant gets the new level.
 *
 * Takes full access, and the organization's policy for a NEW share beyond
 * the resource's team, with the whole organization, or with a guest: turning
 * a policy off keeps the shares that exist, as every policy does, and stops
 * the next ones. The level must be one this type offers — and one a guest may
 * hold, for a guest (`authz/guests.ts`).
 */
export const shareResource = async (input: {
  principal: UserPrincipal;
  type: SharingResourceType;
  id: string;
  principals: readonly PrincipalRef[];
  level: AccessLevel;
}): Promise<ResourceAccess> => {
  const { principal, type, id, level } = input;
  const { node } = await requireSharingRights({ principal, type, id });
  assertShareable(type, level, input.principals);

  const grantees = await resolvePrincipals(
    principal.organizationId,
    input.principals,
  );
  if (input.principals.some((ref) => !grantees.has(principalKey(ref)))) {
    throwHttpError(
      400,
      badRequest(
        "Some of the people or groups picked are not part of this organization.",
      ),
    );
  }
  const { newcomers } = await writeShares({
    principal,
    node,
    type,
    grantees: [...grantees.values()],
    level,
  });
  await tellGuestsShared({ principal, node, type, level, newcomers });
  return describeResourceAccess({ principal, type, id });
};

/**
 * Give these grantees `level` on a resource, in one transaction: the grants
 * (or a chat's seats), their journal entries, the assistant's search index
 * when someone new reaches it, and the pending requests the change answers —
 * whose requesters are then told. The organization's policy applies to a NEW
 * share beyond the resource's team, with the whole organization or with a
 * guest; a guest's grant ends with the period the policy sets, and giving it
 * again starts a new one.
 *
 * Who may make the change is the caller's to check first: full access from
 * the share dialog, taking part for a chat's participants bringing
 * colleagues in (`services/ai/members/`). Answers who was given access for
 * the first time.
 */
export const writeShares = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  grantees: readonly Grantee[];
  level: AccessLevel;
}): Promise<{ readonly newcomers: readonly Grantee[] }> => {
  const { principal, node, type, level } = input;
  const { id } = node;
  // The owner has full access already: a grant would say nothing more.
  const targets = input.grantees.filter(
    (grantee) => !(grantee.type === "user" && grantee.id === node.ownerUserId),
  );
  if (targets.length === 0) return { newcomers: [] };

  const guests = await guestTermsFor({ principal, node, level, targets });

  const done = await db.transaction(async (tx) => {
    const existing = await lockGrants(tx, { type, id }, targets);
    const levelOf = new Map(
      existing.map((grant) => [principalKey(grant), grant.level]),
    );
    const newcomers = targets.filter(
      (target) => !levelOf.has(principalKey(target)),
    );
    await requireSharingPolicy({
      principal,
      node,
      newcomers: newcomers.map((grantee) => ({
        type: grantee.type,
        teamIds: grantee.teamIds,
        guest: grantee.guest,
        inProject: guests.inProject.has(grantee.id),
      })),
    });

    // A level that changes, and a guest's access given again: their period
    // starts over.
    const written = targets.filter(
      (target) =>
        levelOf.get(principalKey(target)) !== level ||
        guests.expiries.has(principalKey(target)),
    );
    await upsertGrants(tx, {
      organizationId: principal.organizationId,
      resource: { type, id },
      refs: written,
      level,
      actorUserId: principal.userId,
      expiries: guests.expiries,
    });
    await recordAccessEvents(
      tx,
      written.map((target): AccessEvent => {
        const previous = levelOf.get(principalKey(target));
        const expiresAt = guests.expiries.get(principalKey(target));
        return {
          organizationId: principal.organizationId,
          actorUserId: principal.userId,
          action: previous === undefined ? "grant.created" : "grant.updated",
          resource: { type, id },
          principal: { type: target.type, id: target.id },
          metadata: {
            level,
            ...(previous === undefined ? {} : { previousLevel: previous }),
            ...(expiresAt === undefined
              ? {}
              : { expiresAt: expiresAt.toISOString() }),
            principalName: target.name,
            resourceName: node.name,
          },
        };
      }),
    );
    if (newcomers.length > 0) {
      await refreshAclsAfterAccessChange({ executor: tx, type, id });
    }
    // Sharing with someone who asked answers them.
    const settled = await settleRequestsAnsweredBy(tx, {
      organizationId: principal.organizationId,
      resource: { type, id, name: node.name },
      userIds: targets.flatMap((target) =>
        target.type === "user" ? [target.id] : [],
      ),
      level,
      deciderUserId: principal.userId,
    });
    return { settled, newcomers };
  });
  await afterAccessChange({ organizationId: principal.organizationId, type });
  await tellRequestersAnswered({
    principal,
    settled: done.settled,
    resource: { type, id, name: node.name },
    level,
  });
  return { newcomers: done.newcomers };
};

/**
 * What the guests among the grantees may be given, checked before anything
 * is written: no more than a guest may hold on this node, for a period the
 * organization's policy sets. A guest who takes part in the node's project
 * works there already (`inProject`): they may take part in its chats, and
 * need no guest right to be given more of it.
 */
const guestTermsFor = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  level: AccessLevel;
  targets: readonly Grantee[];
}): Promise<{
  readonly inProject: ReadonlySet<string>;
  readonly expiries: ReadonlyMap<string, Date>;
}> => {
  const { principal, node, level } = input;
  const guests = input.targets.filter((grantee) => grantee.guest);
  if (guests.length === 0) return { inProject: new Set(), expiries: new Map() };

  const [inProject, policy] = await Promise.all([
    node.projectId === null
      ? new Set<string>()
      : projectParticipants({
          organizationId: principal.organizationId,
          projectId: node.projectId,
          userIds: guests.map((guest) => guest.id),
        }),
    getOrganizationAccessPolicy(principal.organizationId),
  ]);
  for (const guest of guests) {
    assertGuestLevel(node, level, guest.name, inProject.has(guest.id));
  }
  const expiresAt = guestAccessExpiry(policy);
  return {
    inProject,
    expiries: new Map(
      expiresAt === null
        ? []
        : guests.map((guest) => [principalKey(guest), expiresAt] as const),
    ),
  };
};

/** Refuse a level beyond what a guest may hold on the node. */
export const assertGuestLevel = (
  node: LoadedNode,
  level: AccessLevel,
  guestName: string,
  inProject = false,
): void => {
  const ceiling = guestCeilingFor(node, inProject);
  if (levelRank(level) <= levelRank(ceiling)) return;
  throwHttpError(400, {
    code: ERROR_CODES.GUEST_LEVEL_CEILING,
    message: `${guestName} is a guest, and can be given at most ${ceiling} access here.`,
  });
};

/**
 * The level must be one this type offers, to principals it can be shared
 * with — and, for a group, one it offers groups (a chat is read by a team,
 * taken part in by people).
 */
export const assertShareable = (
  type: SharingResourceType,
  level: AccessLevel,
  refs: readonly PrincipalRef[],
): void => {
  const adapter = adapterFor(type);
  if (!adapter.offeredLevels.includes(level)) {
    throwHttpError(
      400,
      badRequest(
        `A ${type} is shared at ${adapter.offeredLevels.join(", ")} access.`,
      ),
    );
  }
  const refused = refs.find(
    (ref) => !adapter.shareablePrincipals.includes(ref.type),
  );
  if (refused !== undefined) {
    throwHttpError(
      400,
      badRequest(`A ${type} cannot be shared with a ${refused.type}.`),
    );
  }
  const groupLevels = adapter.groupLevels ?? adapter.offeredLevels;
  if (!groupLevels.includes(level) && refs.some((ref) => ref.type !== "user")) {
    throwHttpError(
      400,
      badRequest(
        `A team, a project or the organization is given a ${type} at ${groupLevels.join(", ")} access.`,
      ),
    );
  }
};

/** Someone given access for the first time, as the policy sees them. */
export interface Newcomer {
  readonly type: HolderPrincipalType;
  /**
   * The teams they are in — or will join, for an invitation — for "beyond
   * the resource's team". Empty for a guest and for the organization.
   */
  readonly teamIds: ReadonlySet<string>;
  /** From outside the organization, or invited from there. */
  readonly guest: boolean;
  /** A guest who takes part in the resource's project already. */
  readonly inProject: boolean;
}

/**
 * The organization's policy on new shares: with the whole organization, with
 * a guest who is not in the resource's project yet (`guests.invite`, in the
 * resource's team), and beyond the resource's team — a person who is not in
 * it, another team, a project of another team. A guest is governed by the
 * guest policy alone: they are in no team to be beyond.
 */
export const requireSharingPolicy = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  newcomers: readonly Newcomer[];
}): Promise<void> => {
  const { principal, node, newcomers } = input;
  if (newcomers.some((newcomer) => newcomer.type === "organization")) {
    await requireCapability({ principal, capability: "share.organization" });
  }
  if (newcomers.some((newcomer) => newcomer.guest && !newcomer.inProject)) {
    await requireCapability({
      principal,
      capability: "guests.invite",
      teamId: node.teamId,
    });
  }
  const beyondTeam = newcomers.some(
    (newcomer) =>
      newcomer.type !== "organization" &&
      !newcomer.guest &&
      (node.teamId === null || !newcomer.teamIds.has(node.teamId)),
  );
  if (beyondTeam) {
    await requireCapability({ principal, capability: "share.cross_team" });
  }
};
