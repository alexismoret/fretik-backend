import { z } from "@hono/zod-openapi";
import { skillSourceEnum } from "../db/schema/skills";

/**
 * HTTP schemas for `/team-skills/*` routes. Mirrors the @fretik/shared
 * pattern: one schema file per resource, reusable from the frontend via
 * `@fretik/shared/schemas/skills`.
 *
 * The agent-side rendering of the catalogue (system prompt L1 listing)
 * uses `services/skills/list-enabled-for-team.ts` directly — not these
 * HTTP schemas — so the wire shape never bleeds into the prompt.
 */

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
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  version: z.string().min(1).max(20),
  source: skillSourceSchema,
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillsListResponseSchema = z.object({
  skills: z.array(skillSummarySchema),
});
export type SkillsListResponse = z.infer<typeof skillsListResponseSchema>;

export const toggleSkillBodySchema = z.object({
  enabled: z.boolean(),
});
export type ToggleSkillBody = z.infer<typeof toggleSkillBodySchema>;

export const skillNameParamSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .openapi({ param: { name: "name", in: "path" } }),
});
