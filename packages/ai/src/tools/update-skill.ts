import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import { getSkillForTeamById } from "@fretik/shared/services/skills/get-by-id";
import { validateSkillShape } from "@fretik/shared/services/skills/validate";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";

/**
 * Author an UPDATE to an existing team skill and surface it to the
 * user for confirmation. Sibling of `createSkill` for new skills.
 *
 * Like the create tool, this does NOT persist anything. It validates
 * the proposed changes against the existing row and returns a SLIM
 * draft envelope (skill id, current version, resolved name) — body
 * and description are NOT echoed back because the model already has
 * them in `args` and the frontend reads them from there. Echoing
 * would double the body's token cost on every subsequent turn.
 *
 * Bundled and always-on skills cannot be updated — their body is
 * owned by the @fretik/ai service (on disk). Both cases return a
 * structured `skill_read_only` error.
 */
export const createUpdateSkillTool = () =>
  tool({
    description: [
      "Update an existing team skill — adjust its description, rewrite its instructions, or both.",
      "",
      "Use this when:",
      '- The user asks to improve, refine, or fix a skill they already have (e.g. "the X skill should also handle Y", "add a step for Z to the X skill").',
      "- A procedure you just executed reveals a gap or improvement in an existing skill the user wants captured.",
      "",
      "Before calling:",
      '- Read the current skill first with `read("/workspace/skills/<name>/SKILL.md")` so the proposed body builds on what\'s there instead of replacing it blindly.',
      "- Read `/workspace/skills/skill-author/SKILL.md` if you haven't already — the authoring rules apply equally to updates.",
      "- The body field expects the COMPLETE new body, not a diff. Combine the existing content with the changes before calling.",
      "- Ask the user if anything material is ambiguous.",
      "",
      "Bundled and always-on skills cannot be updated — only team-created skills are editable. Calls against those return a `skill_read_only` error.",
      "",
      "The result is surfaced to the user as a draft for them to review and confirm. Only team admins and owners can confirm.",
    ].join("\n"),
    inputSchema: z.object({
      skill_id: z
        .uuid()
        .describe(
          "UUID of the existing team skill to update. Get it from the skill row in the system prompt's skills catalogue.",
        ),
      description: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe(
          "Updated description, third-person, ≤1024 chars, covering what + when. Omit to keep the current description unchanged.",
        ),
      body: z
        .string()
        .min(1)
        .max(102_400)
        .describe(
          "COMPLETE new SKILL.md body in Markdown — not a diff. Include the original content plus the changes. Same rules as for a new skill: imperative voice, numbered steps, real tool names, forward-slash paths, no time-sensitive instructions.",
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);

      if (!ctx.userId) {
        return {
          error: "missing_user_context",
          message:
            "The chatbot session has no user attached — cannot update a skill.",
        };
      }

      try {
        await assertOrgAdmin({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          message: "Updating a skill requires admin or owner role",
        });
      } catch {
        return {
          error: "not_authorized",
          message:
            "Only team admins and owners can save skill changes. Ask an admin in this conversation to confirm — they can read this transcript.",
        };
      }

      const existing = await getSkillForTeamById(input.skill_id, ctx.teamId);
      if (!existing) {
        return {
          error: "skill_not_found",
          message:
            "No skill with that id is visible to this team. Double-check the id from the system prompt's skills catalogue.",
        };
      }

      if (existing.source !== "team_uploaded") {
        return {
          error: "skill_read_only",
          message:
            "Bundled skills cannot be modified — their instructions live on disk and are managed by the platform. Only team-created skills are editable.",
        };
      }

      if (existing.isDefault) {
        return {
          error: "skill_read_only",
          message: "Always-on skills cannot be modified through this tool.",
        };
      }

      const nextDescription = input.description ?? existing.description;
      try {
        validateSkillShape({
          name: existing.name,
          description: nextDescription,
          body: input.body,
        });
      } catch (err) {
        return {
          error: "invalid_draft",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // Slim envelope: only what the frontend can't derive from
      // `args` (the immutable name + current version for the
      // "v1.0.0 → v1.0.1" hint on the card). The body and the
      // possibly-omitted description live on the call side.
      return {
        kind: "skill_draft" as const,
        mode: "update" as const,
        skillId: existing.id,
        name: existing.name,
        currentVersion: existing.version,
      };
    },
  });
