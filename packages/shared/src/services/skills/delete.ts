import { and, eq } from "drizzle-orm";
import db from "../../db";
import { skills } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import { getSkillForTeamById } from "./get-by-id";

export interface DeleteSkillInput {
  id: string;
  teamId: string;
}

/**
 * Soft-delete a team-uploaded skill. Sets `deleted_at` so the row
 * stays around for audit/restore. Bundled skills cannot be deleted.
 *
 * Override rows in `team_skills` are intentionally NOT cleaned up —
 * if the row gets restored later, the team's previous toggle state
 * is recovered automatically.
 */
export const deleteSkill = async (input: DeleteSkillInput): Promise<void> => {
  const existing = await getSkillForTeamById(input.id, input.teamId);
  if (!existing) {
    return throwHttpError(404, {
      code: ERROR_CODES.SKILL_NOT_FOUND,
      message: "Skill not found for this team",
    });
  }
  if (existing.source !== "team_uploaded") {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_BUNDLED_READONLY,
      message: "Bundled skills cannot be deleted",
    });
  }

  await db
    .update(skills)
    .set({ deletedAt: new Date() })
    .where(and(eq(skills.id, input.id), eq(skills.teamId, input.teamId)));
};
