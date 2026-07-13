import db from "../../db";
import { skills } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import {
  emitDomainEvent,
  type EventActor,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { getSkillForTeamById, type SkillDetail } from "./get-by-id";
import { pickAvailableSkillSlug, slugifySkillName } from "./slugify-name";
import { assertScopeEnabledCap, validateSkillShape } from "./validate";

export interface CreateSkillInput {
  teamId: string;
  organizationId: string;
  /**
   * Desired slug or free-form name. Server slugifies + deduplicates
   * before insertion — so `"Extract DAE CSV"` becomes
   * `"extract-dae-csv"`, and if that's taken, `"extract-dae-csv-2"`.
   */
  name: string;
  description: string;
  body: string;
  /** Provenance for a catalog-installed skill, e.g. `skills.sh:<owner>/<repo>/<slug>`. */
  sourceUrl?: string;
  /** Content hash of the source bundle at install time. */
  sourceHash?: string;
  /** Companion files in the source bundle not installed (body-only). */
  skippedFiles?: number;
  actor?: EventActor;
}

/**
 * Create a `team_uploaded` skill for the team. Always enabled at
 * creation — callers wanting a disabled-by-default skill should
 * create then toggle via the existing `PATCH /team-skills/:name`
 * endpoint, which already handles the override row + audit.
 *
 * Failure modes (all 400 unless otherwise noted):
 *  - input name collapses to "" after slugify → `SKILL_INVALID_NAME`
 *  - description/body shape violations → `SKILL_INVALID_*`
 *  - team already at the enabled cap → `SKILL_CAP_REACHED`
 *  - DB constraint violation → 500 `INTERNAL_ERROR`
 */
export const createSkill = async (
  input: CreateSkillInput,
): Promise<SkillDetail> => {
  const baseSlug = slugifySkillName(input.name);
  if (baseSlug.length === 0) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_NAME,
      message:
        "Skill name could not be derived from input — use letters, digits, or hyphens",
    });
  }
  const finalName = await pickAvailableSkillSlug(baseSlug, input.teamId);

  validateSkillShape({
    name: finalName,
    description: input.description,
    body: input.body,
  });

  await assertScopeEnabledCap(input.teamId);

  const actor = input.actor ?? SYSTEM_ACTOR;
  // Wrap the insert so the journal entry is co-transactional with it.
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(skills)
      .values({
        name: finalName,
        description: input.description,
        body: input.body,
        source: "team_uploaded",
        teamId: input.teamId,
        version: "1.0.0",
        sourceUrl: input.sourceUrl,
        sourceHash: input.sourceHash,
        sourceSkippedFiles: input.skippedFiles ?? 0,
      })
      .returning({ id: skills.id });

    if (!inserted) {
      return throwHttpError(500, {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "Failed to insert skill",
      });
    }

    await emitDomainEvent({
      tx,
      organizationId: input.organizationId,
      teamId: input.teamId,
      type: "skill.created",
      actor,
      subjectType: "skill",
      payload: { skillId: inserted.id, name: finalName },
      dedupKey: `skill.created:${inserted.id}`,
    });
    return inserted;
  });

  const created = await getSkillForTeamById(row.id, input.teamId);
  if (!created) {
    return throwHttpError(500, {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Skill disappeared right after creation",
    });
  }
  return created;
};
