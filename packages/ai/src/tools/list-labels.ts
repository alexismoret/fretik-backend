import db from "@fretik/shared/db";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";

/**
 * Domain tool — lists the team's labels.
 *
 * Labels are team-scoped free-form tags (name + optional hex colour),
 * historically created but unused. They now feed:
 *   • the drive filter (label filter)
 *   • the vectoriser (label names embedded into chunks)
 *   • the chatbot, via this tool + the `labelIds` filter on `listDocuments`.
 *
 * Returns the full list (typical team has < 100 labels — no pagination).
 */
export const createListLabelsTool = () =>
  tool({
    description: [
      "List the team's labels (free-form tags applied to documents).",
      "",
      "Use this when the user mentions a label by name (e.g. 'show me urgent invoices') or needs to discover what labels exist before filtering. Pass the returned label id(s) to `listDocuments`'s `labelIds` filter to narrow down.",
      "",
      "Returns id, name and color for every label on the active team.",
    ].join("\n"),
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive substring of the label name (useful when the team has many labels).",
        ),
    }),
    execute: async ({ search }, options) => {
      const ctx = getRuntimeContext(options);
      const labels = await db.query.labels.findMany({
        columns: { id: true, name: true, color: true },
        where: {
          teamId: ctx.teamId,
          ...(search && { name: { ilike: `%${search}%` } }),
        },
        orderBy: { name: "asc" },
      });
      return { labels };
    },
  });
