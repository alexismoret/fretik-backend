import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import { loadPageProjectContext } from "./context";

/**
 * Find where something is, across the page's files.
 *
 * The alternative is reading every file to answer "where is the currency
 * formatted?", which is what a project costs an agent that cannot search it.
 * Results are capped rather than paginated: a query returning fifty lines is
 * the wrong query, and saying so is more useful than a second page of it.
 */

const MAX_RESULTS = 50;
const MAX_LINE_CHARS = 160;

export const createPageSearchTool = () =>
  tool({
    description:
      "Search the page's files for a regular expression. Returns `path:line: text`, capped — narrow the query rather than paging. Use it to find where something lives before reading a whole file.",
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .max(200)
        .describe("JavaScript regular expression, case-insensitive."),
      path: z
        .string()
        .optional()
        .describe("Restrict to one file. Omit to search all of them."),
      filesOnly: z
        .boolean()
        .optional()
        .describe("Return only the file names that match, not the lines."),
    }),
    execute: async (input, options) => {
      const project = await loadPageProjectContext(options);
      const { state } = project;

      let matcher: RegExp;
      try {
        matcher = new RegExp(input.pattern, "i");
      } catch (error) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `That is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const entries = Object.entries(state.files)
        .filter(([path]) => input.path === undefined || path === input.path)
        .sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) {
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          input.path === undefined
            ? "This page has no files yet."
            : `This page has no "${input.path}".`,
        );
      }

      const hits: string[] = [];
      const files = new Set<string>();
      let total = 0;
      for (const [path, content] of entries) {
        for (const [index, line] of content.split("\n").entries()) {
          if (!matcher.test(line)) continue;
          total += 1;
          files.add(path);
          if (hits.length < MAX_RESULTS) {
            hits.push(
              `${path}:${(index + 1).toString()}: ${line.trim().slice(0, MAX_LINE_CHARS)}`,
            );
          }
        }
      }

      if (input.filesOnly === true) {
        return { files: [...files], matches: total };
      }
      return {
        matches: total,
        results: hits,
        ...(total > hits.length
          ? {
              notice: `${total.toString()} matches, ${hits.length.toString()} shown. Narrow the pattern.`,
            }
          : {}),
      };
    },
  });
