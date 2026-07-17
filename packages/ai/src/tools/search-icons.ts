import { searchIcons } from "@fretik/shared/lib/icons/search";
import { tool } from "ai";
import { z } from "zod";

/**
 * Domain tool (deferred) — find valid icon names for object types / select
 * options. Backed by the curated Lucide catalog (ranked on Lucide's own tags).
 * Accepts several concepts at once so one call covers a whole type's icon needs
 * (the type + each of its options) — never one call per option.
 */
export const createSearchIconsTool = () =>
  tool({
    description:
      "Find icon names from the curated Lucide catalog. Pass every concept you need icons for at once (e.g. ['project','invoice','urgent']); returns ranked names per concept. Use the chosen `name` with manageObjectType / manageField, which reject names outside the catalog.",
    inputSchema: z.object({
      queries: z
        .array(z.string().min(1).max(60))
        .min(1)
        .max(20)
        .describe("Concepts to illustrate, e.g. ['delivery','contract']."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Max icons per concept (default 8)."),
    }),
    execute: async ({ queries, limit }) => ({
      results: queries.map((query) => ({
        query,
        // The tool exposes bare names (the agent passes a `name` to
        // manageObjectType / manageField); `searchIcons` returns {name,tags}.
        icons: searchIcons(query, limit ?? 8).map((r) => r.name),
      })),
    }),
  });
