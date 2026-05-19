import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { aiConversations, skills, teamSkills } from "../../db/schema";

/**
 * One team-uploaded skill ready to be materialised into the sandbox
 * filesystem. Carries the full markdown body so the caller can write
 * it as `/workspace/skills/<slug>/SKILL.md` without a second query.
 */
export interface TeamUploadedSkillFile {
  name: string;
  description: string;
  body: string;
}

/**
 * Return every enabled, soft-undeleted, team-uploaded skill for the
 * team that owns the given conversation, ready to be pushed into the
 * sandbox during bootstrap.
 *
 * "Enabled" means: no team override row OR override.enabled = true.
 * Bundled skills are intentionally excluded — they're already pushed
 * separately via the pre-built tarball in `pushBundledSkills`.
 *
 * Returns `[]` when the conversation is unknown or has no
 * team-uploaded skills enabled. Callers should treat that as the
 * normal empty case (most conversations until teams start authoring).
 *
 * Ordering: name ASC, deterministic so two parallel bootstraps land
 * the same files in the same order (helps debugging).
 */
export const listEnabledTeamUploadedSkillsWithBodyForConversation = async (
  conversationId: string,
): Promise<TeamUploadedSkillFile[]> => {
  // 1. Resolve teamId from the conversation. Bootstrap can be called
  //    for a freshly-created conversation, so we tolerate "no row" by
  //    returning an empty list rather than throwing.
  const convRows = await db
    .select({ teamId: aiConversations.teamId })
    .from(aiConversations)
    .where(eq(aiConversations.id, conversationId))
    .limit(1);

  const teamId = convRows[0]?.teamId;
  if (!teamId) return [];

  // 2. Pull every team_uploaded skill for that team along with its
  //    override row (if any). Effective enabled = no override OR
  //    override.enabled === true (matches `computeEffectiveEnabled`).
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      body: skills.body,
      overrideEnabled: teamSkills.enabled,
    })
    .from(skills)
    .leftJoin(
      teamSkills,
      and(eq(teamSkills.skillId, skills.id), eq(teamSkills.teamId, teamId)),
    )
    .where(
      and(
        eq(skills.source, "team_uploaded"),
        eq(skills.teamId, teamId),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(asc(skills.name));

  return rows
    .filter((row) => row.overrideEnabled !== false && row.body !== null)
    .map((row) => ({
      name: row.name,
      description: row.description,
      // `body !== null` is enforced above and by the DB check constraint
      // for team_uploaded — the non-null assertion is shape only.
      body: row.body as string,
    }));
};
