import { assertOrgAdmin } from "@fretik/shared/lib/auth-roles";
import { pickAvailableSkillSlug } from "@fretik/shared/services/skills/slugify-name";
import { validateSkillShape } from "@fretik/shared/services/skills/validate";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";

/**
 * Author a new team skill and surface it to the user for confirmation.
 *
 * The tool itself does NOT persist anything. It validates the proposed
 * frontmatter + body and returns a SLIM draft envelope: only the data
 * the server resolved (final slug after dedup, status). Body and
 * description are intentionally NOT echoed back — the frontend reads
 * them from the tool call's `args` so the model context doesn't
 * carry the body twice (once in `args.body`, once in `result.body`)
 * which would double the token cost on every subsequent turn.
 *
 * The frontend renderer recognises `kind: "skill_draft"` and pairs
 * the result envelope with the matching `args` (both are available
 * on every `<UChatTool>` part) to render the card with Save / Edit &
 * Save / Cancel buttons.
 *
 * Authoring conventions live in the bundled `skill-author` skill at
 * `/workspace/skills/skill-author/SKILL.md`. The tool description
 * tells the model to read it first so the proposal respects the rules.
 *
 * Authz: only org owners / admins can save skills. Non-admins get a
 * `not_authorized` error so the assistant relays it politely instead
 * of producing a draft that would be rejected on save.
 */
export const createCreateSkillTool = () =>
  tool({
    description: [
      "Author a new team skill — a saved set of instructions the assistant will load and follow in future conversations whenever the user asks for the same kind of task.",
      "",
      "Use this when:",
      "- The user wants the assistant to remember how to do something so they don't have to re-explain it next time.",
      "- The user describes a recurring task and wants it captured as a recipe / template / procedure / skill.",
      "- The user points to something done earlier in this conversation and wants it preserved for future use.",
      '- The user phrases the request in any natural way that implies "I want to be able to ask for this again later".',
      "",
      "Before calling:",
      "- Read `/workspace/skills/skill-author/SKILL.md` for the authoring rules (frontmatter, body shape, anti-patterns, available tools).",
      "- If the user described what they want, work from their description. If they're referring to earlier in the conversation, extract the procedure from the transcript instead. The two are equally valid sources.",
      "- If anything material is unclear (when the skill should trigger, what the output should be, what inputs are required), ask the user before drafting. One good question is better than three small ones.",
      "",
      "The result is surfaced to the user as a draft for them to review and confirm — only confirmed drafts are saved. Only team admins and owners can confirm; non-admin callers receive a `not_authorized` error to relay.",
    ].join("\n"),
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          'Short slug for the skill. Lowercase letters, digits, and single hyphens only (e.g. "monthly-report", "extract-invoices"). The server slugifies free-form input and resolves duplicates, so propose a clean descriptive name without worrying about uniqueness.',
        ),
      description: z
        .string()
        .min(1)
        .max(1024)
        .describe(
          'Third-person summary, ≤1024 characters, covering BOTH what the skill does AND when to trigger it. Include the phrases the user actually says (e.g. "Use when the user asks for a monthly digest, weekly recap, or any variant phrasing"). This is the only thing the chatbot reads when deciding whether to load the skill — vague descriptions mean the skill won\'t fire.',
        ),
      body: z
        .string()
        .min(1)
        .max(102_400)
        .describe(
          "Full SKILL.md body in Markdown, ideally under 500 lines. Imperative voice, numbered steps, reference tools by their actual names (`python`, `sql_query`, `present_files`, etc.). Forward-slash paths only. No time-sensitive instructions. See `/workspace/skills/skill-author/SKILL.md` for the full guide and worked examples.",
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);

      if (!ctx.userId) {
        return {
          error: "missing_user_context",
          message:
            "The chatbot session has no user attached — cannot author a skill.",
        };
      }

      // Authz first so a non-admin doesn't see a slug-validation error
      // when the real blocker is permissions.
      try {
        await assertOrgAdmin({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          message: "Saving a skill requires admin or owner role",
        });
      } catch {
        return {
          error: "not_authorized",
          message:
            "Only team admins and owners can save skills. Ask an admin in this conversation to confirm the save — they can read this transcript.",
        };
      }

      let finalName: string;
      try {
        finalName = await pickAvailableSkillSlug(input.name, ctx.teamId);
      } catch (err) {
        return {
          error: "name_resolution_failed",
          message:
            err instanceof Error
              ? err.message
              : "Could not derive a valid slug from the proposed name.",
        };
      }

      // `validateSkillShape` throws an HTTPException via
      // `throwHttpError`. In a tool we must never throw for expected
      // failures — convert to a structured error the model can react
      // to and retry with corrections.
      try {
        validateSkillShape({
          name: finalName,
          description: input.description,
          body: input.body,
        });
      } catch (err) {
        return {
          error: "invalid_draft",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // Slim envelope: only what the server resolved that the model
      // (and the frontend) can't derive from the call's `args`. Body
      // and description live on the call side and are read directly
      // by the renderer — duplicating them here would double their
      // token cost in every subsequent turn.
      return {
        kind: "skill_draft" as const,
        mode: "create" as const,
        resolvedName: finalName,
      };
    },
  });
