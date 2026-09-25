import db from "../../db";

/**
 * How many teams an organization may have — read by Better Auth's own
 * `createTeam` (`teams.maximumTeams` in `lib/auth.ts`) and by ours
 * (`services/team/create.ts`), so the two doors enforce one ceiling.
 *
 * No settings row (an organization predating `afterCreateOrganization`, or an
 * insert that failed) must not silently cap it at one team: it falls back to
 * the same default the column carries.
 */
export const DEFAULT_MAXIMUM_TEAMS = 10;

export const maximumTeamsFor = async (
  organizationId: string,
): Promise<number> => {
  const settings = await db.query.organizationSettings.findFirst({
    columns: { maxAgencies: true },
    where: { organizationId },
  });
  return settings?.maxAgencies ?? DEFAULT_MAXIMUM_TEAMS;
};
