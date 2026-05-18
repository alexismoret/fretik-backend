import { and, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import { skills, teamSkills } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import { listSkillsForTeam, type EffectiveSkill } from "./list-for-team";

/**
 * Toggle a configurable skill on or off for a given team.
 *
 *   1. Resolves the skill by `name`. The lookup is scoped to skills
 *      visible to this team: a global `bundled` row OR a
 *      `team_uploaded` row owned by `teamId`. Unknown name → 404
 *      `SKILL_NOT_FOUND`.
 *   2. Refuses always-on skills (`isDefault = true`) with 400
 *      `SKILL_NOT_TOGGLEABLE` — the UI also disables the toggle but
 *      a forged PUT must not bypass the rule.
 *   3. UPSERT the `team_skills` row. The composite PK (team_id,
 *      skill_id) means there is exactly one override per (team,
 *      skill) — the second toggle just updates `enabled` +
 *      `updated_by_id` + `enabled_at`.
 *
 * Returns the effective skill state as the API consumer would see
 * it after the write — sourced from `listSkillsForTeam` so the
 * effective-state rule is single-sourced.
 */
export const upsertTeamSkillOverride = async (input: {
  teamId: string;
  skillName: string;
  enabled: boolean;
  updatedById: string;
}): Promise<EffectiveSkill> => {
  const { teamId, skillName, enabled, updatedById } = input;

  // 1. Resolve the skill. `findFirst` because either (source='bundled'
  // AND team_id IS NULL) OR (source='team_uploaded' AND team_id=$teamId)
  // is unique per name (`skills_team_name_unique` constraint).
  const rows = await db
    .select({
      id: skills.id,
      isDefault: skills.isDefault,
    })
    .from(skills)
    .where(
      and(
        eq(skills.name, skillName),
        isNull(skills.deletedAt),
        or(
          and(eq(skills.source, "bundled"), isNull(skills.teamId)),
          and(eq(skills.source, "team_uploaded"), eq(skills.teamId, teamId)),
        ),
      ),
    )
    .limit(1);

  const skill = rows[0];
  if (!skill) {
    return throwHttpError(404, {
      code: ERROR_CODES.SKILL_NOT_FOUND,
      message: `Skill "${skillName}" not found for this team`,
    });
  }

  // 2. Always-on guard. Mirrors the disabled USwitch in the UI.
  if (skill.isDefault) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_NOT_TOGGLEABLE,
      message: `Skill "${skillName}" is always on and cannot be disabled`,
    });
  }

  // 3. UPSERT the override row. `onConflictDoUpdate` keeps the same
  // row across repeated toggles and refreshes the audit fields.
  await db
    .insert(teamSkills)
    .values({
      teamId,
      skillId: skill.id,
      enabled,
      updatedById,
    })
    .onConflictDoUpdate({
      target: [teamSkills.teamId, teamSkills.skillId],
      set: {
        enabled,
        updatedById,
        enabledAt: new Date(),
      },
    });

  // 4. Return the effective summary — re-uses the single source of
  // truth for "what the team sees" so the API response can't drift
  // from what the listing endpoint returns on the next page load.
  const after = await listSkillsForTeam(teamId);
  const updated = after.find((s) => s.name === skillName);
  if (!updated) {
    // Concurrent soft-delete after our write — vanishingly rare, but
    // surface clearly rather than return a stale shape.
    return throwHttpError(404, {
      code: ERROR_CODES.SKILL_NOT_FOUND,
      message: `Skill "${skillName}" disappeared after update`,
    });
  }
  return updated;
};
