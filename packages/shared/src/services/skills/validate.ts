import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import { skills, teamSkills } from "../../db/schema";
import { throwHttpError } from "../../lib/errors";
import { ERROR_CODES } from "../../schemas/errors";
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_REGEX,
} from "../../schemas/skills-limits";

/**
 * Per-team cap on enabled `team_uploaded` skills. Bundled skills don't
 * count. Sized to keep the system-prompt L1 catalogue bounded:
 * 30 × ~320 tokens (name + description) ≈ 10k tokens, comfortable.
 */
const MAX_ENABLED_TEAM_UPLOADED_PER_TEAM = 30;

/**
 * Boundary validator for team-uploaded skill input. Throws 400 with a
 * specific error code on the first violation. The Anthropic spec is
 * the source of truth for name/description rules (see constants.ts).
 *
 * The DB `skills_body_max_length` check would also catch oversized
 * bodies, but we surface a friendlier code/message before the INSERT
 * fails with a generic constraint violation.
 */
export const validateSkillShape = (input: {
  name: string;
  description: string;
  body: string;
}): void => {
  if (input.name.length === 0 || input.name.length > SKILL_NAME_MAX_LENGTH) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_NAME,
      message: `Skill name must be 1 to ${SKILL_NAME_MAX_LENGTH} characters`,
    });
  }
  if (!SKILL_NAME_REGEX.test(input.name)) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_NAME,
      message:
        "Skill name must be a lowercase slug: letters, digits, and single hyphens only (no leading/trailing/double hyphens)",
    });
  }

  const trimmedDesc = input.description.trim();
  if (trimmedDesc.length === 0) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_DESCRIPTION,
      message: "Skill description is required",
    });
  }
  if (trimmedDesc.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_DESCRIPTION,
      message: `Skill description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer`,
    });
  }
  // Cheap heuristic for "no XML tags" — catches the common case
  // (`<tag>`, `<script>`) without a full HTML parser. False positives
  // on `<` followed by a letter are acceptable; users rarely need
  // that in a one-line description and the message points at the rule.
  if (/<[a-z]/i.test(trimmedDesc)) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_DESCRIPTION,
      message: "Skill description cannot contain XML tags",
    });
  }

  if (input.body.trim().length === 0) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_BODY,
      message: "Skill body cannot be empty",
    });
  }
  const bodyBytes = new TextEncoder().encode(input.body).byteLength;
  if (bodyBytes > SKILL_BODY_MAX_BYTES) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_INVALID_BODY,
      message: `Skill body must be ${SKILL_BODY_MAX_BYTES} bytes or fewer (got ${bodyBytes})`,
    });
  }
};

/**
 * Throws 400 if creating one more enabled team_uploaded skill would
 * push the team over its cap. Counts effective-enabled rows only
 * (skill with no override = enabled by default; override.enabled =
 * false subtracts from the count).
 */
export const assertScopeEnabledCap = async (teamId: string): Promise<void> => {
  const rows = await db
    .select({
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
    );

  const enabledCount = rows.filter((r) => r.overrideEnabled !== false).length;

  if (enabledCount >= MAX_ENABLED_TEAM_UPLOADED_PER_TEAM) {
    return throwHttpError(400, {
      code: ERROR_CODES.SKILL_CAP_REACHED,
      message: `Team has reached the maximum of ${MAX_ENABLED_TEAM_UPLOADED_PER_TEAM} enabled custom skills. Disable or delete one before adding another.`,
    });
  }
};
