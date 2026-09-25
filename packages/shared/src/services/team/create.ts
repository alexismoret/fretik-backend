import { count, eq } from "drizzle-orm";
import { requireCapability } from "../../authz/gates";
import type { UserPrincipal } from "../../authz/principal";
import db from "../../db";
import { team, teamMemberRoles } from "../../db/schema";
import { MAX_MEMBERS_PER_TEAM } from "../../lib/auth-constants";
import { onMembershipChanged, onTeamCreated } from "../../lib/auth-membership";
import { throwHttpError } from "../../lib/errors";
import { organizationAdapter } from "../../lib/org-adapter";
import { ERROR_CODES } from "../../schemas/errors";
import type { TeamSummary } from "../../schemas/teams";
import { recordAccessEvent } from "../access/record-event";
import { maximumTeamsFor } from "../organization/team-limit";

/**
 * Create a team, led by the person who created it.
 *
 * Who may is the organization's policy (`teams.create`: its admins, or every
 * member). Written through Better Auth's adapter, which fires no hook, so the
 * team's setup — its agent user, its field definitions — runs here, through
 * the same `onTeamCreated` the plugin's hook calls.
 */
export const createTeam = async (input: {
  principal: UserPrincipal;
  name: string;
}): Promise<TeamSummary> => {
  const { principal } = input;
  const { organizationId } = principal;
  await requireCapability({ principal, capability: "teams.create" });

  const [existing] = await db
    .select({ value: count() })
    .from(team)
    .where(eq(team.organizationId, organizationId));
  const maximum = await maximumTeamsFor(organizationId);
  if ((existing?.value ?? 0) >= maximum) {
    return throwHttpError(409, {
      code: ERROR_CODES.TEAM_LIMIT_REACHED,
      message: `The organization already has ${maximum.toString()} teams, its limit.`,
    });
  }

  const adapter = await organizationAdapter();
  const now = new Date();
  const created = await adapter.createTeam({
    name: input.name,
    organizationId,
    createdAt: now,
    updatedAt: now,
  });
  await onTeamCreated({ teamId: created.id, organizationId });

  const seat = await adapter.addTeamMemberWithLimit({
    teamId: created.id,
    userId: principal.userId,
    maximumMembersPerTeam: MAX_MEMBERS_PER_TEAM,
  });
  await db.transaction(async (tx) => {
    if (seat.status === "added") {
      await tx
        .insert(teamMemberRoles)
        .values({
          teamMemberId: seat.member.id,
          teamId: created.id,
          userId: principal.userId,
          role: "lead",
          updatedByUserId: principal.userId,
        })
        .onConflictDoNothing();
    }
    await recordAccessEvent({
      executor: tx,
      organizationId,
      actorUserId: principal.userId,
      action: "team.created",
      principal: { type: "team", id: created.id },
      metadata: { teamName: created.name },
    });
  });
  // The creator's new seat: `onTeamCreated` bumped before it existed.
  await onMembershipChanged(organizationId);

  return {
    id: created.id,
    name: created.name,
    createdAt: created.createdAt,
    memberCount: seat.status === "added" ? 1 : 0,
    role: seat.status === "added" ? "lead" : null,
  };
};
