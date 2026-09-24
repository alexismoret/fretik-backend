import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { bumpAccessVersion } from "../authz/load-principal";
import db from "../db";
import { pauseWorkflowsOfDepartedMember } from "../services/workflows/owner-presence";
import { scrubWorkflowNotificationRecipient } from "../services/workflows/scrub-notification-recipient";
import {
  invalidateMemberRoleCache,
  invalidateOrgTeamMembershipCache,
  invalidateTeamMembershipCache,
} from "./auth-roles";

/**
 * What follows a change of membership — whichever door it came through.
 *
 * Better Auth fires `organizationHooks` for most doors (removing a member,
 * removing a team member, changing a role), but not for `/organization/leave`
 * nor for the writes our own hooks make through its adapter (the team
 * invitation of `auth-hooks.ts`). Every door calls the same functions here, so
 * a person who leaves on their own is treated exactly like one who was
 * removed.
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

/** Anything changed who belongs where in the organization. */
export const onMembershipChanged = async (
  organizationId: string,
): Promise<void> => {
  await bestEffort("access version bump", () =>
    bumpAccessVersion(organizationId),
  );
};

/** A person left the organization — removed, or of their own accord. */
export const onMemberLeftOrganization = async (input: {
  organizationId: string;
  userId: string;
}): Promise<void> => {
  const { organizationId, userId } = input;
  await onMembershipChanged(organizationId);
  // `authMiddleware` caches team membership and the role; removing an org
  // member also drops their `team_member` rows, so a live session would keep
  // team access until the TTL expired.
  await bestEffort("team membership cache", () =>
    invalidateOrgTeamMembershipCache(organizationId, userId),
  );
  await bestEffort("member role cache", () =>
    invalidateMemberRoleCache(organizationId, userId),
  );
  // Workflow notification recipients are jsonb userId lists (no FK).
  await bestEffort("notification recipients", () =>
    scrubWorkflowNotificationRecipient({ userId, organizationId }),
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

/** The shape `/organization/leave` answers with: the member row that left. */
const leftMemberSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
});

/**
 * Better Auth `after` hook for the one door with no organization hook:
 * leaving. Runs only when the endpoint succeeded — a refused leave (the last
 * owner) left nothing to clean up.
 */
export const organizationMembershipAfterHooks = createAuthMiddleware(
  async (ctx) => {
    if (ctx.path !== "/organization/leave") return;
    const returned: unknown = ctx.context.returned;
    if (returned instanceof APIError) return;
    const left = leftMemberSchema.safeParse(returned);
    if (!left.success) return;
    await onMemberLeftOrganization(left.data);
  },
);
