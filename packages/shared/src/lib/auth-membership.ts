import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { bumpAccessVersion } from "../authz/load-principal";
import db from "../db";
import { recordAccessEvent } from "../services/access/record-event";
import { bootstrapTeamWithBotUser } from "../services/auth/bot-user";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";
import { pauseWorkflowsOfDepartedMember } from "../services/workflows/owner-presence";
import { scrubWorkflowNotificationRecipient } from "../services/workflows/scrub-notification-recipient";
import {
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
