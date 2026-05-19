import { and, eq } from "drizzle-orm";
import db from "../../db";
import { skills, teamSkills } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import { getSkillForTeamById, type SkillDetail } from "./get-by-id";
import { validateSkillShape } from "./validate";

export interface UpdateSkillInput {
  id: string;
  teamId: string;
  /** Acting user — recorded in `team_skills.updated_by_id` when the
   *  `enabled` field is patched. */
  updatedById: string;
  description?: string;
  body?: string;
  enabled?: boolean;
}

/**
 * Semver patch bump used on every body change. Description-only and
 * enabled-only edits keep the same version (only the body
 * materialises in the sandbox SKILL.md file). Falls back to
 * `"1.0.0"` if the existing version isn't parseable.
 */
const bumpPatchVersion = (current: string): string => {
  const [majRaw, minRaw, patchRaw, ...extra] = current.split(".");
  if (
    extra.length > 0 ||
    majRaw === undefined ||
    minRaw === undefined ||
    patchRaw === undefined
  ) {
    return "1.0.0";
  }
  const maj = Number.parseInt(majRaw, 10);
  const min = Number.parseInt(minRaw, 10);
  const patch = Number.parseInt(patchRaw, 10);
  if (Number.isNaN(maj) || Number.isNaN(min) || Number.isNaN(patch)) {
    return "1.0.0";
  }
  return `${maj}.${min}.${patch + 1}`;
};

/**
 * Single patch endpoint for both content edits (description/body) and
 * the enable/disable toggle. Mirrors REST semantics: PATCH on the
 * resource updates whichever fields the caller sent.
 *
 * Bundled vs team_uploaded:
 *  - `bundled`         only `enabled` can be patched (the on-disk
 *                      SKILL.md is source-of-truth for body/desc).
 *                      Sending body or description on a bundled row
 *                      returns 400 `SKILL_BUNDLED_READONLY`.
 *  - `team_uploaded`   all three fields are editable.
 *
 * `isDefault` always-on skills reject any `enabled` patch with
 * 400 `SKILL_NOT_TOGGLEABLE` regardless of source.
 *
 * Renaming is intentionally not supported: it would orphan the
 * sandbox SKILL.md file and any RAG embeddings keyed on the slug.
 * Callers wanting a rename must delete + recreate.
 *
 * The toggle path upserts the `team_skills` override row (composite
 * PK on team_id + skill_id). The content path updates the `skills`
 * row in place and bumps `version` when the body changes.
 */
export const updateSkill = async (
  input: UpdateSkillInput,
): Promise<SkillDetail> => {
  const existing = await getSkillForTeamById(input.id, input.teamId);
  if (!existing) {
    return throwHttpError(404, {
      code: ERROR_CODES.SKILL_NOT_FOUND,
      message: "Skill not found for this team",
    });
  }

  const wantsContentChange =
    input.description !== undefined || input.body !== undefined;
  const wantsEnabledChange = input.enabled !== undefined;

  // Bundled rows: only the enabled flag is mutable.
  if (existing.source !== "team_uploaded" && wantsContentChange) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_BUNDLED_READONLY,
      message:
        "Bundled skills can only be enabled or disabled — their content lives on disk",
    });
  }

  // Always-on skills can never be disabled.
  if (existing.isDefault && wantsEnabledChange) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_NOT_TOGGLEABLE,
      message: `Skill "${existing.name}" is always on and cannot be disabled`,
    });
  }

  // Content patch (team_uploaded only at this point).
  if (wantsContentChange) {
    if (existing.body === null) {
      return throwHttpError(500, {
        code: ERROR_CODES.INTERNAL_ERROR,
        message:
          "Existing team-uploaded skill has no body — data invariant violated",
      });
    }
    const nextDescription = input.description ?? existing.description;
    const nextBody = input.body ?? existing.body;

    validateSkillShape({
      name: existing.name,
      description: nextDescription,
      body: nextBody,
    });

    const bodyChanged =
      input.body !== undefined && input.body !== existing.body;
    const nextVersion = bodyChanged
      ? bumpPatchVersion(existing.version)
      : existing.version;

    await db
      .update(skills)
      .set({
        description: nextDescription,
        body: nextBody,
        version: nextVersion,
      })
      .where(and(eq(skills.id, input.id), eq(skills.teamId, input.teamId)));
  }

  // Enabled patch — upsert the override row. Idempotent across
  // repeated toggles; refreshes the audit fields on every call.
  if (wantsEnabledChange && input.enabled !== undefined) {
    await db
      .insert(teamSkills)
      .values({
        teamId: input.teamId,
        skillId: input.id,
        enabled: input.enabled,
        updatedById: input.updatedById,
      })
      .onConflictDoUpdate({
        target: [teamSkills.teamId, teamSkills.skillId],
        set: {
          enabled: input.enabled,
          updatedById: input.updatedById,
          enabledAt: new Date(),
        },
      });
  }

  const updated = await getSkillForTeamById(input.id, input.teamId);
  if (!updated) {
    return throwHttpError(500, {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Skill disappeared after update",
    });
  }
  return updated;
};
