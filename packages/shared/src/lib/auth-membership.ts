import { bumpAccessVersion } from "../authz/load-principal";
import db from "../db";
import {
  endGuestPeriods,
  settleAcceptedInvitation,
} from "../services/access/guests/accept-invitation";
import { dropInvitationGrants } from "../services/access/guests/invitation-grants";
import { recordAccessEvent } from "../services/access/record-event";
import { bootstrapTeamWithBotUser } from "../services/auth/bot-user";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";
import { pauseWorkflowsOfDepartedMember } from "../services/workflows/owner-presence";
import { scrubWorkflowNotificationRecipient } from "../services/workflows/scrub-notification-recipient";
import { forgetWorkspace } from "../services/workspaces/last-workspace";
import {
  invalidateOrgTeamMembershipCache,
  invalidateTeamMembershipCache,
} from "./auth-roles";

/**
 * What follows a change of membership — whichever door it came through.
 *
 * Better Auth fires `organizationHooks` for most doors (removing a member,
 * removing a team member, changing a role), but not for `/organization/leave`
 * (`auth-after-hooks.ts` catches it) nor for the writes our own hooks make
 * through its adapter (the team invitation of `auth-hooks.ts`). Every door
 * calls the same functions here, so a person who leaves on their own is
 * treated exactly like one who was removed.
 *
 * Every step is best-effort and never blocks the membership change itself —
 * the change has already happened when these run, and each consumer re-checks
 * at its own point of use (the send path re-reads the roster, run creation
 * re-checks a workflow's owner). The access version is the exception worth
 * naming: it is what makes a cached principal notice, so it is bumped first.
 */

const bestEffort = async (label: string, work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (err) {
    console.warn(`[membership] ${label} failed:`, err);
  }
};

/**
 * The journal entry for a change one of Better Auth's own endpoints made. It
 * follows the change rather than committing with it, so it is best-effort
 * like the rest of this file: the change stands either way.
 */
export const journalAfterTheFact = async (
  entry: Parameters<typeof recordAccessEvent>[0],
): Promise<void> => {
  await bestEffort("access journal", () => recordAccessEvent(entry));
};

/** Anything changed who belongs where in the organization. */
export const onMembershipChanged = async (
  organizationId: string,
): Promise<void> => {
  await bestEffort("access version bump", () =>
    bumpAccessVersion(organizationId),
  );
};

/**
 * A team was created — through Better Auth's endpoint (its `afterCreateTeam`
 * hook) or ours (`services/team/create.ts`, which writes through the
 * adapter and so fires no hook). NOT best-effort, unlike the rest of this
 * file: a team without its agent user or its field definitions breaks
 * invariants every read of the team relies on, so a failure here must surface.
 */
export const onTeamCreated = async (input: {
  teamId: string;
  organizationId: string;
}): Promise<void> => {
  await bootstrapTeamWithBotUser(input);
  // The runtime reads always expect the org-scope field definitions to have
  // been duplicated into the team.
  await duplicateOrgDefsToTeam(input);
  await onMembershipChanged(input.organizationId);
};

/** A person left the organization — removed, or of their own accord. */
export const onMemberLeftOrganization = async (input: {
  organizationId: string;
  userId: string;
}): Promise<void> => {
  const { organizationId, userId } = input;
  await onMembershipChanged(organizationId);
  // `authMiddleware` caches team membership; removing an org member also
  // drops their `team_member` rows, so a live session would keep team access
  // until the TTL expired.
  await bestEffort("team membership cache", () =>
    invalidateOrgTeamMembershipCache(organizationId, userId),
  );
  // Workflow notification recipients are jsonb userId lists (no FK).
  await bestEffort("notification recipients", () =>
    scrubWorkflowNotificationRecipient({ userId, organizationId }),
  );
  // Where they last worked, if it was here: nothing of it is theirs now.
  await bestEffort("last workspace", () =>
    forgetWorkspace({ userId, organizationId }),
  );
  // Their private workflows ran as them (`workflows/owner-presence.ts`).
  await bestEffort("departed owner workflows", async () => {
    const teams = await db.query.team.findMany({
      columns: { id: true },
      where: { organizationId },
    });
    await pauseWorkflowsOfDepartedMember({
      userId,
      teamIds: teams.map((t) => t.id),
    });
  });
};

/** A person left one team of the organization. */
export const onMemberLeftTeam = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
}): Promise<void> => {
  const { organizationId, teamId, userId } = input;
  await onMembershipChanged(organizationId);
  await bestEffort("team membership cache", () =>
    invalidateTeamMembershipCache(teamId, userId),
  );
  await bestEffort("notification recipients", () =>
    scrubWorkflowNotificationRecipient({ userId, teamId }),
  );
  await bestEffort("departed owner workflows", () =>
    pauseWorkflowsOfDepartedMember({ userId, teamIds: [teamId] }),
  );
};

/**
 * An invitation was accepted — through Better Auth's endpoint or ours: what
 * it was shared for becomes the person's (`services/access/guests/`).
 * Best-effort like the rest of this file: the membership stands either way,
 * and the invitation's grants wait, giving nothing, if this failed.
 */
export const onInvitationAccepted = async (input: {
  organizationId: string;
  invitationId: string;
  userId: string;
}): Promise<void> => {
  await bestEffort("invitation grants", () => settleAcceptedInvitation(input));
};

/**
 * A guest accepted an invitation to join as a member, which made them one
 * (`auth-hooks.ts`): their grants no longer end with a guest's period, and
 * the journal records the change of role like any other.
 */
export const onGuestPromoted = async (input: {
  organizationId: string;
  userId: string;
  userName: string;
  role: string;
}): Promise<void> => {
  await bestEffort("guest promotion", () =>
    db.transaction(async (tx) => {
      await endGuestPeriods(tx, input);
      await recordAccessEvent({
        executor: tx,
        organizationId: input.organizationId,
        actorUserId: input.userId,
        action: "member.role_changed",
        principal: { type: "user", id: input.userId },
        metadata: { userName: input.userName, from: "guest", to: input.role },
      });
    }),
  );
};

/**
 * An invitation will never be accepted — declined by its recipient, or
 * withdrawn: what it was shared for goes with it, and the journal says so.
 */
export const onInvitationClosed = async (input: {
  organizationId: string;
  invitationId: string;
  email: string;
  actorUserId: string | null;
  action: "invitation.canceled" | "invitation.rejected";
}): Promise<void> => {
  await bestEffort("invitation grants", () =>
    db.transaction(async (tx) => {
      const dropped = await dropInvitationGrants(tx, input.invitationId);
      await recordAccessEvent({
        executor: tx,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: input.action,
        principal: { type: "invitation", id: input.invitationId },
        metadata: { email: input.email, items: dropped.length },
      });
    }),
  );
};
