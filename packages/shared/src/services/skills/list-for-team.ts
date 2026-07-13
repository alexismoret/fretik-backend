import { and, asc, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import { skills, teamSkills } from "../../db/schema";
import { computeEffectiveEnabled } from "./compute-effective-enabled";

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
  /** Provenance of a catalog-installed skill, or null. */
  sourceUrl: string | null;
}

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
      sourceUrl: skills.sourceUrl,
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
        // Meta skills (bundled infrastructure consumed by chatbot
        // tools, e.g. skill-author) are hidden from every
        // human-visible listing — saves prompt tokens in the
        // catalogue and avoids cluttering the settings page with
        // rows the user can't act on. They still ship with the
        // bundled tarball so the sandbox has them.
        eq(skills.isMeta, false),
        or(
          // Bundled = global (no team scope), visible to every team.
          and(eq(skills.source, "bundled"), isNull(skills.teamId)),
          // Team-uploaded = scoped to this team.
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
    sourceUrl: row.sourceUrl,
  }));
};
