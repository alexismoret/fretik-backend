import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import { installSkillFromCatalog } from "@fretik/shared/services/skills/install-from-catalog";
import { tool } from "ai";
import { z } from "zod";
import { gateBuiltinWriteTool } from "../agents/shared/policy-tool-gate";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";

/**
 * Install a skill from the catalog to the team, behind the write-approval gate.
 *
 * Admin/owner only. When the team's policy is `approval` (the default), the
 * change surfaces as an approval card and only lands once the user confirms —
 * the API process applies it via `TOOL_CALL_APPLY.installSkill`. Idempotent:
 * re-installing the same skill returns the existing one.
 */
export const createInstallSkillTool = () =>
  tool({
    description: [
      "Install a skill from the catalog (found via `searchSkills`) to the team, so the assistant can load and follow it in future conversations.",
      "Use right after `searchSkills` returns a candidate the user wants. Pass the candidate's exact `id`.",
      "Admin/owner only; the change goes through the user's approval before it is saved.",
    ].join("\n"),
    inputSchema: z.object({
      id: z
        .string()
        .min(3)
        .max(300)
        .describe(
          "The catalog skill's `id` (owner/repo/slug) from a `searchSkills` result.",
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.userId) {
        return {
          error: "missing_user_context",
          message:
            "The chatbot session has no user attached — cannot install a skill.",
        };
      }

      const [owner, repo, ...slugParts] = input.id.split("/");
      const slug = slugParts.join("/");
      if (owner === undefined || repo === undefined || slug === "") {
        return {
          error: "invalid_id",
          message:
            "Skill id must be `owner/repo/slug` from a searchSkills result.",
        };
      }

      try {
        await assertOrgAdmin({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          message: "Installing a skill requires admin or owner role",
        });
      } catch {
        return {
          error: "not_authorized",
          message:
            "Only team admins and owners can install skills. Ask an admin in this conversation to confirm.",
        };
      }

      const gate = await gateBuiltinWriteTool(ctx, {
        toolName: "installSkill",
        args: { id: input.id },
      });
      if (gate !== null) return gate;

      try {
        const skill = await installSkillFromCatalog({
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
          owner,
          repo,
          slug,
          actor: agentEventActor(ctx),
        });
        return { ok: true, name: skill.name, description: skill.description };
      } catch (err) {
        return {
          error: "install_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
