import { z } from "@hono/zod-openapi";
import { skillSourceEnum } from "../db/schema/skills";
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_REGEX,
  SKILL_VERSION_MAX_LENGTH,
} from "./skills-limits";

/**
 * HTTP schemas for `/team-skills/*` and `/skills/*` routes. Mirrors the
 * @fretik/shared pattern: one schema file per resource, reusable from
 * the frontend via `@fretik/shared/schemas/skills`.
 *
 * Validation limits (name regex, max lengths, body byte cap) live in
 * `./skills-limits.ts` so the DB schema can import them without
 * forming an import cycle with this file.
 *
 * The agent-side rendering of the catalogue (system prompt L1 listing)
 * uses `services/skills/list-enabled-for-team.ts` directly — not these
 * HTTP schemas — so the wire shape never bleeds into the prompt.
 */

// Re-export limits so consumers can grab schema + constants from a
// single entry point (frontend, services, tests).
export {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_REGEX,
  SKILL_VERSION_MAX_LENGTH,
};

export const skillSourceSchema = z.enum(skillSourceEnum.enumValues);
export type SkillSourceValue = z.infer<typeof skillSourceSchema>;

/**
 * Public summary of one skill as the team-skills settings UI shows it.
 *  - `enabled`   = effective state (always `true` when `isDefault`).
 *  - `isDefault` = always-on skill, USwitch is rendered disabled and
 *                  the PUT toggle endpoint refuses with
 *                  SKILL_NOT_TOGGLEABLE.
 *  - `source`    = `bundled` today; `team_uploaded` lands when the
 *                  user-upload feature ships.
 */
export const skillSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH).regex(SKILL_NAME_REGEX),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  version: z.string().min(1).max(SKILL_VERSION_MAX_LENGTH),
  source: skillSourceSchema,
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillsListResponseSchema = z.object({
  skills: z.array(skillSummarySchema),
});
export type SkillsListResponse = z.infer<typeof skillsListResponseSchema>;

// ============================================================================
// `/skills/*` (team-uploaded CRUD) — written by org owner/admin from the
// settings page, read by everyone for the editor + the sandbox bootstrap.
// ============================================================================

/**
 * Editor view: skill summary + markdown body + audit timestamps. The
 * body is `nullable` because bundled rows mirror the catalogue but
 * leave the on-disk SKILL.md as source-of-truth (only team-uploaded
 * rows carry the body in-DB).
 */
export const skillDetailSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH).regex(SKILL_NAME_REGEX),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
  body: z.string().max(SKILL_BODY_MAX_BYTES).nullable(),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  version: z.string().min(1).max(SKILL_VERSION_MAX_LENGTH),
  source: skillSourceSchema,
  teamId: z.uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

/**
 * Create request — `name` is the desired slug or any free-form label.
 * The server slugifies + deduplicates before insertion. Body is
 * required; the new skill is always created in the enabled state and
 * users can toggle via the existing `/team-skills/:name` endpoint.
 */
export const createSkillRequestSchema = z.object({
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
  body: z.string().min(1).max(SKILL_BODY_MAX_BYTES),
});
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>;

/**
 * Update request — name is immutable (renaming would orphan sandbox
 * files and RAG embeddings; delete + recreate instead). At least one
 * of `description`, `body`, or `enabled` must be set; the toggle is
 * the `{ enabled }` only case. Bundled skills accept only `enabled`;
 * the service layer rejects content patches on bundled with
 * `SKILL_BUNDLED_READONLY`.
 */
export const updateSkillRequestSchema = z
  .object({
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH).optional(),
    body: z.string().min(1).max(SKILL_BODY_MAX_BYTES).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (val) =>
      val.description !== undefined ||
      val.body !== undefined ||
      val.enabled !== undefined,
    {
      message: "At least one of description, body, or enabled must be provided",
    },
  );
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;

export const skillIdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});
