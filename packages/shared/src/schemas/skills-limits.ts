/**
 * Validation limits for skills — kept in a standalone file so both
 * `db/schema/skills.ts` and `schemas/skills.ts` can import without
 * pulling in each other (which would form an import cycle drizzle-kit
 * can't resolve at schema-parse time).
 *
 * These mirror the Anthropic SKILL.md frontmatter spec verbatim
 * (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
 * The DB schema and the service layer import from here, so changing a
 * value in one place updates the column/check, the Zod boundary, and
 * the service guards together.
 */

/** Max chars for the skill slug. Matches the agentskills.io cap. */
export const SKILL_NAME_MAX_LENGTH = 64;

/**
 * Slug = lowercase alphanumerics joined by single hyphens. No leading,
 * trailing or doubled hyphens. Single-char slugs allowed.
 */
export const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Max chars for the third-person "what + when" description. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Max bytes for the full SKILL.md body. ~25k tokens — well past
 * Anthropic's soft 500-line target but tight enough to keep one
 * pathological skill from blowing up the sandbox extraction.
 * Enforced both at the Zod boundary and via DB CHECK constraint.
 */
export const SKILL_BODY_MAX_BYTES = 102_400;

/** DB `version` column is `varchar(N)`; mirror in the response shape. */
export const SKILL_VERSION_MAX_LENGTH = 20;
