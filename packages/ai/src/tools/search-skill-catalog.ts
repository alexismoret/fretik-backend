import { searchSkillCatalog } from "@fretik/shared/services/skills/search-catalog";
import { tool } from "ai";
import { z } from "zod";

/**
 * Search the public skill catalog for an installable skill — read-only. Only
 * the search query is sent to the catalog (discovery, no team data). Returns
 * candidates the user can install with `installSkill`.
 */
export const createSearchSkillCatalogTool = () =>
  tool({
    description: [
      "Search the public skill catalog for a ready-made skill (a saved playbook the assistant loads and follows) matching a capability the team doesn't have yet.",
      "Use when the user wants a capability that isn't already a team skill — e.g. they ask you to do a specialized task and no matching skill exists. Returns candidates with an `id`; install one with `installSkill` (pass that `id`).",
      "Read-only: it only searches. Prefer an existing team skill when one already covers the need.",
    ].join("\n"),
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'What the skill should do, in a few words (e.g. "summarize meeting notes", "generate invoices from a spreadsheet").',
        ),
    }),
    execute: async (input) => {
      try {
        const result = await searchSkillCatalog({
          q: input.query,
          pageSize: 10,
        });
        return {
          skills: result.entries.map((s) => ({
            id: s.id,
            displayName: s.displayName,
            description: s.description,
            installs: s.installs,
            official: s.official,
          })),
        };
      } catch (err) {
        return {
          error: "catalog_unavailable",
          message:
            err instanceof Error
              ? err.message
              : "The skill catalog is unavailable right now.",
        };
      }
    },
  });
