import { PAGE_ENTRY_FILE } from "@fretik/shared/schemas/pages";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import { hashFileContent } from "../../services/page-project/store";
import { loadPageProjectContext, manifestOf, numberLines } from "./context";

/**
 * Read one file of the page being built, line-numbered.
 *
 * The numbers are `cat -n`, not part of the file: they exist so an error at
 * `components/KpiStrip.vue:41` can be found without counting, and the tool that
 * writes refuses content that carries them back.
 */

const MAX_LINES = 400;

export const createPageReadTool = () =>
  tool({
    description:
      "Read a file of the page you are building, with line numbers. Call it with no `path` for the project's manifest — every file, its size and what it exposes. Line numbers are NOT part of the file: never copy them into an edit or a write.",
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe(
          `Which file — "${PAGE_ENTRY_FILE}", "components/Name.vue", "composables/useName.ts", "lib/name.ts". Omit for the manifest.`,
        ),
      pageId: z
        .uuid()
        .optional()
        .describe(
          "Only on your FIRST call, and only when repairing a page that already exists: it loads that page's files into this run.",
        ),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("First line to return, 1-based. Omit to start at the top."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LINES)
        .optional()
        .describe(`How many lines. Default ${MAX_LINES.toString()}.`),
    }),
    execute: async (input, options) => {
      const project = await loadPageProjectContext(options, input.pageId);
      const { state } = project;

      if (input.path === undefined) {
        await project.save(state);
        return {
          manifest: manifestOf(state),
          ...(state.pageId !== undefined ? { pageId: state.pageId } : {}),
        };
      }

      const content = state.files[input.path];
      if (content === undefined) {
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `This page has no "${input.path}".`,
          `Its files are: ${Object.keys(state.files).join(", ") || "none yet"}. Create one with pageWrite.`,
        );
      }

      const lines = content.split("\n");
      const from = input.offset ?? 1;
      const count = Math.min(input.limit ?? MAX_LINES, MAX_LINES);
      const slice = lines.slice(from - 1, from - 1 + count);

      // Reading a file that has not changed since the last read returns
      // nothing but the fact: the content is already in the context that asked
      // for it, and re-sending it is the cheapest way to spend a budget.
      const seen = state.seen[input.path];
      const hash = hashFileContent(content);
      if (seen?.readHash === hash && input.offset === undefined) {
        return {
          path: input.path,
          unchanged: true,
          notice:
            "Unchanged since you last read it — use that result rather than this one.",
        };
      }

      await project.save({
        ...state,
        seen: {
          ...state.seen,
          [input.path]: { ...seen, readAt: Date.now(), readHash: hash },
        },
      });

      return {
        path: input.path,
        totalLines: lines.length,
        content: numberLines(slice.join("\n"), from),
        ...(from + slice.length - 1 < lines.length
          ? {
              notice: `Lines ${from.toString()}-${(from + slice.length - 1).toString()} of ${lines.length.toString()}. Continue with offset ${(from + slice.length).toString()}.`,
            }
          : {}),
      };
    },
  });
