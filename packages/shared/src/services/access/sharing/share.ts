import { adapterFor } from "../../../authz/access";
import { requireCapability } from "../../../authz/gates";
import type { UserPrincipal } from "../../../authz/principal";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { badRequest, throwHttpError } from "../../../lib/errors";
import type { AccessLevel } from "../../../schemas/access";
import type {
  ResourceAccess,
  SharingResourceType,
} from "../../../schemas/access-sharing";
import { refreshAclsAfterAccessChange } from "../../ai-vectors/acl";
import { type AccessEvent, recordAccessEvents } from "../record-event";
import { tellRequestersAnswered } from "../requests/answered-by-share";
import { settleRequestsAnsweredBy } from "../requests/settle-requests";
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
 * the resource's team or with the whole organization: turning a policy off
 * keeps the shares that exist, as every policy does, and stops the next
 * ones. The level must be one this type offers.
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
  await writeShares({
    principal,
    node,
    type,
    grantees: [...grantees.values()],
    level,
  });
  return describeResourceAccess({ principal, type, id });
};

/**
 * Give these grantees `level` on a resource, in one transaction: the grants
 * (or a chat's seats), their journal entries, the assistant's search index
 * when someone new reaches it, and the pending requests the change answers —
 * whose requesters are then told. The organization's policy applies to a NEW
 * share beyond the resource's team or with the whole organization.
 *
 * Who may make the change is the caller's to check first: full access from
 * the share dialog, taking part for a chat's participants bringing
 * colleagues in (`services/ai/members/`).
 */
export const writeShares = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  type: SharingResourceType;
  grantees: readonly Grantee[];
  level: AccessLevel;
}): Promise<void> => {
  const { principal, node, type, level } = input;
  const { id } = node;
  // The owner has full access already: a grant would say nothing more.
  const targets = input.grantees.filter(
    (grantee) => !(grantee.type === "user" && grantee.id === node.ownerUserId),
  );
  if (targets.length === 0) return;

  const settled = await db.transaction(async (tx) => {
    const existing = await lockGrants(tx, { type, id }, targets);
    const levelOf = new Map(
      existing.map((grant) => [principalKey(grant), grant.level]),
    );
    const newcomers = targets.filter(
      (target) => !levelOf.has(principalKey(target)),
    );
    await requireSharingPolicy({ principal, node, newcomers });

    const changed = targets.filter(
      (target) => levelOf.get(principalKey(target)) !== level,
    );
    await upsertGrants(tx, {
      organizationId: principal.organizationId,
      resource: { type, id },
      refs: changed,
      level,
      actorUserId: principal.userId,
    });
    await recordAccessEvents(
      tx,
      changed.map((target): AccessEvent => {
        const previous = levelOf.get(principalKey(target));
        return {
          organizationId: principal.organizationId,
          actorUserId: principal.userId,
          action: previous === undefined ? "grant.created" : "grant.updated",
          resource: { type, id },
          principal: { type: target.type, id: target.id },
          metadata: {
            level,
            ...(previous === undefined ? {} : { previousLevel: previous }),
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
    return settleRequestsAnsweredBy(tx, {
      organizationId: principal.organizationId,
      resource: { type, id, name: node.name },
      userIds: targets.flatMap((target) =>
        target.type === "user" ? [target.id] : [],
      ),
      level,
      deciderUserId: principal.userId,
    });
  });
  await tellRequestersAnswered({
    principal,
    settled,
    resource: { type, id, name: node.name },
    level,
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

/**
 * The organization's policy on new shares: with the whole organization, and
 * beyond the resource's team — a person who is not in it, another team, a
 * project of another team.
 */
const requireSharingPolicy = async (input: {
  principal: UserPrincipal;
  node: LoadedNode;
  newcomers: readonly Grantee[];
}): Promise<void> => {
  const { principal, node, newcomers } = input;
  if (newcomers.some((grantee) => grantee.type === "organization")) {
    await requireCapability({ principal, capability: "share.organization" });
  }
  const beyondTeam = newcomers.some(
    (grantee) =>
      grantee.type !== "organization" &&
      (node.teamId === null || !grantee.teamIds.has(node.teamId)),
  );
  if (beyondTeam) {
    await requireCapability({ principal, capability: "share.cross_team" });
  }
};
