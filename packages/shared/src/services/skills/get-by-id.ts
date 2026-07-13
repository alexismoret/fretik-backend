import { and, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import { skills, teamSkills } from "../../db/schema";
import { computeEffectiveEnabled } from "./compute-effective-enabled";

/**
 * Skill detail row — same shape as `EffectiveSkill` but also carries
 * the markdown body, the owning team_id, and the timestamps. The
 * settings editor reads this; the system-prompt catalogue does not
 * (it uses the lightweight `listEnabledSkillsForTeam` to keep the
 * prompt bytes deterministic and small).
 */
export interface SkillDetail {
  id: string;
  name: string;
  description: string;
  body: string | null;
  isDefault: boolean;
  enabled: boolean;
  version: string;
  source: "bundled" | "team_uploaded";
  sourceUrl: string | null;
  skippedFiles: number;
  teamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fetch one skill by id, scoped to skills the team is allowed to
 * see (a global bundled row OR a team_uploaded row owned by
 * `teamId`). Returns `null` when the id doesn't match or the row
 * was soft-deleted.
 */
export const getSkillForTeamById = async (
  skillId: string,
  teamId: string,
): Promise<SkillDetail | null> => {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      body: skills.body,
      isDefault: skills.isDefault,
      version: skills.version,
      source: skills.source,
      sourceUrl: skills.sourceUrl,
      skippedFiles: skills.sourceSkippedFiles,
      teamId: skills.teamId,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
      overrideEnabled: teamSkills.enabled,
    })
    .from(skills)
    .leftJoin(
      teamSkills,
      and(eq(teamSkills.skillId, skills.id), eq(teamSkills.teamId, teamId)),
    )
    .where(
      and(
        eq(skills.id, skillId),
        isNull(skills.deletedAt),
        // Meta skills are bundled infrastructure consumed by chatbot
        // tools — never exposed to the editor / settings UI, same
        // rule as in `listSkillsForTeam`.
        eq(skills.isMeta, false),
        or(
          and(eq(skills.source, "bundled"), isNull(skills.teamId)),
          and(eq(skills.source, "team_uploaded"), eq(skills.teamId, teamId)),
        ),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    isDefault: row.isDefault,
    enabled: computeEffectiveEnabled(row.isDefault, row.overrideEnabled),
    version: row.version,
    source: row.source,
    sourceUrl: row.sourceUrl,
    skippedFiles: row.skippedFiles,
    teamId: row.teamId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
