/**
 * Per-team "bot" user used as the `createdById` / `uploadedById` audit value
 * for records created by the workflow engine (SaaS nodes: document upload,
 * extraction launch, folder create, …). Exactly one bot user exists per team,
 * created by the Better Auth `afterCreateTeam` hook in api/src/lib/auth.ts
 * and referenced by `team_settings.bot_user_id` (NOT NULL, FK restricted so
 * the bot user cannot be deleted while the team still exists).
 *
 * Bot users have no password and no `account` row so they cannot log in.
 * They are flagged at the organization level with `member.role = 'bot'` and
 * participate in `team_member` so existing team-scoped queries keep working.
 */

import { eq, sql } from "drizzle-orm";
import db from "../../db";
import { member, team, teamMember, teamSettings, user } from "../../db/schema";

/**
 * Better Auth 1.7's `team_member.membership_key`:
 * base64url(sha256(JSON.stringify([teamId, userId]))), unpadded.
 *
 * Recomputed here because the bot user is inserted directly rather than
 * through Better Auth's `addTeamMember` — see the call site. A NULL key would
 * work (lookups fall back to the (teamId, userId) pair) but would leave the
 * single-column uniqueness boundary unenforced for exactly the row we control.
 */
const teamMembershipKey = async (
  teamId: string,
  userId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, userId])),
  );
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/**
 * Deterministic email used for a team's bot user. Non-routable domain so the
 * address can never be used for real communication; the team id keeps it
 * globally unique under the `user.email` unique constraint and makes the
 * upsert in `createBotUserForTeam` idempotent.
 */
export const botEmailForTeam = (teamId: string): string =>
  `bot+${teamId}@bot.fretik.local`;

/**
 * Bootstraps a freshly created team: creates the bot user, wires up all
 * membership rows, and inserts the `team_settings` row with `botUserId`
 * already populated. Since `team_settings.bot_user_id` is NOT NULL, this
 * function is the single place that can legally insert a `team_settings`
 * row — the Better Auth `afterCreateTeam` hook delegates to it rather than
 * inserting settings itself.
 *
 * Side effects (in a single transaction):
 * - `user`: the bot user record (name "Bot", verified, no password)
 * - `member`: organization-level membership with role "bot"
 * - `team_member`: team-level membership
 * - `team_settings`: the settings row, with `bot_user_id` set
 *
 * Idempotent: calling it twice for the same team returns the existing bot
 * user id. The deterministic `botEmailForTeam` keeps the upsert safe.
 */
export const bootstrapTeamWithBotUser = async (params: {
  teamId: string;
  organizationId: string;
}): Promise<string> => {
  const { teamId, organizationId } = params;
  const email = botEmailForTeam(teamId);

  return await db.transaction(async (tx) => {
    // 1. Insert the user. ON CONFLICT returns the existing row so this stays
    //    idempotent if the hook fires twice or the backfill migration raced.
    const [botUser] = await tx
      .insert(user)
      .values({
        name: "Bot",
        email,
        emailVerified: true,
      })
      .onConflictDoUpdate({
        target: user.email,
        set: { name: "Bot" },
      })
      .returning({ id: user.id });

    if (!botUser) {
      throw new Error(
        `Failed to create bot user for team ${teamId} (email ${email})`,
      );
    }

    // 2. Organization-level membership. Role "bot" makes the record easy to
    //    filter out of human-facing member lists.
    await tx
      .insert(member)
      .values({
        organizationId,
        userId: botUser.id,
        role: "bot",
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    // 3. Team-level membership.
    //
    //    Written directly rather than through Better Auth's addTeamMember,
    //    which means the two columns 1.7 maintains for itself are ours to
    //    keep honest: the membership key, and the cached seat count that
    //    `teams.maximumMembersPerTeam` is enforced against. Leaving the count
    //    alone would let every team hold one extra human for each bot.
    const [insertedTeamMember] = await tx
      .insert(teamMember)
      .values({
        teamId,
        userId: botUser.id,
        membershipKey: await teamMembershipKey(teamId, botUser.id),
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: teamMember.id });

    // Only on a real insert — this function is idempotent and re-runs on
    // retries, where the row already exists and the seat is already counted.
    if (insertedTeamMember) {
      await tx
        .update(team)
        .set({ memberCount: sql`${team.memberCount} + 1` })
        .where(eq(team.id, teamId));
    }

    // 4. Insert the team settings row with the bot user already referenced.
    //    If the row already exists (re-run / race), keep it and just refresh
    //    the bot user pointer so the NOT NULL invariant is preserved.
    await tx
      .insert(teamSettings)
      .values({ teamId, botUserId: botUser.id })
      .onConflictDoUpdate({
        target: teamSettings.teamId,
        set: { botUserId: botUser.id },
      });

    return botUser.id;
  });
};

/**
 * Returns the bot user id for a team. Throws if the team settings row is
 * missing or has no bot user configured — both situations indicate a broken
 * invariant (every team is supposed to have a bot user created by the auth
 * hook or populated by the backfill migration).
 */
export const getTeamBotUserId = async (teamId: string): Promise<string> => {
  const row = await db.query.teamSettings.findFirst({
    where: { teamId },
    columns: { botUserId: true },
  });

  if (!row) {
    throw new Error(`Team settings for team ${teamId} not found`);
  }
  return row.botUserId;
};
