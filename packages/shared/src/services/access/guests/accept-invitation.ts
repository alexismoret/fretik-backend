import { and, eq } from "drizzle-orm";
import { adapterFor } from "../../../authz/access";
import { GUEST_LEVEL_CEILING, guestAccessExpiry } from "../../../authz/guests";
import { capLevel, levelRank } from "../../../authz/levels";
import {
  bumpAccessVersion,
  loadPrincipal,
} from "../../../authz/load-principal";
import { levelCeiling } from "../../../authz/rules";
import db, { type Executor } from "../../../db";
import { accessGrants } from "../../../db/schema";
import type { AccessLevel } from "../../../schemas/access";
import { refreshAclsAfterAccessChange } from "../../ai-vectors/acl";
import { getOrganizationAccessPolicy } from "../../organization/access-policy";
import { type AccessEvent, recordAccessEvents } from "../record-event";
import { lockGrants, upsertGrants } from "../sharing/grant-store";
import { principalKey } from "../sharing/principals";
import { dropInvitationGrants, grantsOfInvitation } from "./invitation-grants";

/**
 * An invitation was accepted: what it was sent for becomes the person's.
 *
 * Called from both doors an invitation is accepted through — Better Auth's
 * (`afterAcceptInvitation`, someone new to the organization) and ours
 * (`lib/auth-hooks.ts`, someone already in it) — once the person is a member,
 * so their principal is the one the grants are measured against.
 *
 * Each grant the invitation holds is written through the resource's own store
 * (a chat's seat, a grant), at the level it was sent with — capped by what the
 * person may hold now that they are in (the item may have moved or been
 * restricted since), and by a guest's ceiling for a guest, whose grants end
 * with the organization's period, starting today. A level they hold already
 * and that is at least as high stays as it is. Then the invitation's own
 * grants go, and the whole change commits at once: the invitation gives what
 * it announced, or nothing yet.
 */
export const settleAcceptedInvitation = async (input: {
  organizationId: string;
  invitationId: string;
  userId: string;
}): Promise<void> => {
  const { organizationId, invitationId, userId } = input;
  const [held, sent] = await Promise.all([
    grantsOfInvitation(db, invitationId),
    db.query.invitation.findFirst({
      columns: { email: true, teamId: true },
      where: { id: invitationId },
    }),
  ]);
  // The team it opened, named as the journal keeps names: at write time.
  const teamId = sent?.teamId?.split(",")[0] ?? null;
  const joinedTeam = teamId
    ? await db.query.team.findFirst({
        columns: { name: true },
        where: { id: teamId },
      })
    : undefined;

  // The membership just changed: a principal cached before it is stale.
  await bumpAccessVersion(organizationId);
  const principal = await loadPrincipal({ organizationId, userId });
  if (!principal) return;
  const expiresAt = principal.isGuest
    ? guestAccessExpiry(await getOrganizationAccessPolicy(organizationId))
    : null;
  const you = { type: "user" as const, id: userId };

  await db.transaction(async (tx) => {
    const events: AccessEvent[] = [];
    for (const grant of held) {
      // eslint-disable-next-line no-await-in-loop -- a handful of items, in order
      const nodes = await adapterFor(grant.type).loadNodes([grant.id], tx);
      const node = nodes.get(grant.id);
      if (!node || node.organizationId !== organizationId) continue;

      const ceiling = principal.isGuest
        ? capLevel(levelCeiling(principal, node), GUEST_LEVEL_CEILING)
        : levelCeiling(principal, node);
      const level: AccessLevel = capLevel(grant.level, ceiling) ?? "view";
      // eslint-disable-next-line no-await-in-loop -- a handful of items, in order
      const [current] = await lockGrants(tx, grant, [you]);
      if (current && levelRank(current.level) >= levelRank(level)) continue;

      // eslint-disable-next-line no-await-in-loop -- a handful of items, in order
      await upsertGrants(tx, {
        organizationId,
        resource: grant,
        refs: [you],
        level,
        // Given by whoever shared it, as the dialog will say.
        actorUserId: grant.grantedByUserId ?? userId,
        expiries: new Map(
          expiresAt === null ? [] : [[principalKey(you), expiresAt]],
        ),
      });
      // eslint-disable-next-line no-await-in-loop -- a handful of items, in order
      await refreshAclsAfterAccessChange({
        executor: tx,
        type: grant.type,
        id: grant.id,
      });
      events.push({
        organizationId,
        actorUserId: grant.grantedByUserId,
        action: current ? "grant.updated" : "grant.created",
        resource: grant,
        principal: you,
        metadata: {
          level,
          ...(current ? { previousLevel: current.level } : {}),
          ...(expiresAt === null ? {} : { expiresAt: expiresAt.toISOString() }),
          resourceName: node.name,
          invitationId,
        },
      });
    }
    await dropInvitationGrants(tx, invitationId);
    events.push({
      organizationId,
      actorUserId: userId,
      action: "invitation.accepted",
      principal: { type: "invitation", id: invitationId },
      metadata: {
        role: principal.orgRole,
        items: held.length,
        email: sent?.email ?? null,
        teamId,
        teamName: joinedTeam?.name ?? null,
      },
    });
    await recordAccessEvents(tx, events);
  });
  // A project given to them changes what their principal reaches.
  await bumpAccessVersion(organizationId);
};

/**
 * A guest became a member of the organization (an admin changed their role,
 * or they accepted an invitation to a team): their grants no longer end with
 * a guest's period.
 */
export const endGuestPeriods = async (
  executor: Executor,
  input: { organizationId: string; userId: string },
): Promise<void> => {
  await executor
    .update(accessGrants)
    .set({ expiresAt: null })
    .where(
      and(
        eq(accessGrants.organizationId, input.organizationId),
        eq(accessGrants.principalType, "user"),
        eq(accessGrants.principalId, input.userId),
      ),
    );
};
