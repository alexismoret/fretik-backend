import { and, asc, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import { skills, teamSkills } from "../../db/schema";

/**
 * Effective skill state for a given team.
 *
 *  - `enabled`   = current effective state. Always-on skills
 *                  (`isDefault = true`) report `true` regardless of any
 *                  team_skills override (the API also refuses to write
 *                  overrides for them).
 *  - `isDefault` = `true` ⇒ always-on / not toggleable. The frontend
 *                  shows it as a disabled USwitch with an "Always on"
 *                  badge; the API rejects PUT with SKILL_NOT_TOGGLEABLE.
 *  - Future user-uploaded skills (`source = 'team_uploaded'`) are
 *                  included here when their `team_id` matches.
 */
export interface EffectiveSkill {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  enabled: boolean;
  version: string;
  source: "bundled" | "team_uploaded";
}

/**
 * Pure rule for "is this skill enabled for this team right now?".
 * Exported so tests can pin the contract without spinning up Postgres,
 * and so the upsert handler / API layer can apply the same rule when
 * shaping a single-skill response.
 *
 * Contract:
 *   - Always-on skills (`isDefault = true`) are enabled forever; any
 *     stale row in `team_skills` for them is intentionally ignored
 *     here (the upsert service refuses to write one in the first
 *     place, but defence-in-depth: the rule wins even if a row exists).
 *   - Configurable skills follow the team's explicit override when
 *     present, otherwise default-on (today every configurable skill
 *     ships enabled — flipping the default to off later is a one-line
 *     change here without schema churn).
 */
export const computeEffectiveEnabled = (
  isDefault: boolean,
  overrideEnabled: boolean | null,
): boolean => {
  if (isDefault) return true;
  return overrideEnabled ?? true;
};

/**
 * List every skill visible to a given team — both the global
 * `bundled` catalogue and the team's own `team_uploaded` skills (the
 * latter is a placeholder for the future user-upload story; today it
 * always returns empty for every team).
 *
 * Effective `enabled` is computed in TS rather than in SQL so the
 * always-on rule (`isDefault → enabled = true`) is single-sourced and
 * doesn't have to be mirrored in three places (SQL view, app code,
 * tests).
 *
 * Ordering: name ASC, deterministic so the agent prompt + UI listing
 * stay byte-identical across two reads with no state change.
 *
 * Soft-deleted catalogue rows (`deleted_at IS NOT NULL`) are excluded.
 */
export const listSkillsForTeam = async (
  teamId: string,
): Promise<EffectiveSkill[]> => {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      isDefault: skills.isDefault,
      version: skills.version,
      source: skills.source,
      // Overrides: null when no row exists for (team, skill); otherwise
      // the explicit boolean the team set.
      overrideEnabled: teamSkills.enabled,
    })
    .from(skills)
    .leftJoin(
      teamSkills,
      and(eq(teamSkills.skillId, skills.id), eq(teamSkills.teamId, teamId)),
    )
    .where(
      and(
        isNull(skills.deletedAt),
        or(
          // Bundled = global (no team scope), visible to every team.
          and(eq(skills.source, "bundled"), isNull(skills.teamId)),
          // Team-uploaded = scoped to this team. No row exists today;
          // wired now so the future user-upload path needs no schema
          // change.
          and(eq(skills.source, "team_uploaded"), eq(skills.teamId, teamId)),
        ),
      ),
    )
    .orderBy(asc(skills.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    enabled: computeEffectiveEnabled(row.isDefault, row.overrideEnabled),
    version: row.version,
    source: row.source,
  }));
};
