import {
  PAGE_ENTRY_FILE,
  PAGE_FILE_PATH_RE,
  PAGE_LIMITS,
} from "@fretik/shared/schemas/pages";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import { hashFileContent } from "../../services/page-project/store";
import { measurePageWrite } from "../../services/page-project/write-stats";
import { isEntry, loadPageProjectContext, looksLineNumbered } from "./context";
import { lintDelta } from "./lint";

/**
 * Write one whole file of the page.
 *
 * The unit is a FILE because that is the unit a model rewrites reliably: over
 * two production builds, a fix touching 7% of a 2 000-line page re-emitted the
 * whole thing three times over. A 200-line component costs 2 000 tokens to
 * rewrite, and rewriting it is often the right answer.
 *
 * Nothing here is visible to anyone until `pageBuild` is green — a file that
 * does not compile still lands, which is what makes fixing it an edit instead
 * of a re-emission.
 */

/** Past this a file stops being one thing, and the lint says so at build. */
const SOFT_LINE_LIMIT = 300;

export const createPageWriteTool = () =>
  tool({
    description: `Create or REPLACE one whole file of the page. Nothing is visible to viewers until pageBuild is green, so a file that does not compile yet still lands here. Use it for a new file, and for a change past ~20 lines; pageEdit is for a smaller one. Several pageWrite calls in ONE message is the normal way to lay out a project. Keep a file under ${SOFT_LINE_LIMIT.toString()} lines: one component, one responsibility.`,
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          `"${PAGE_ENTRY_FILE}" (the page itself), "components/Name.vue" (usable as <Name> anywhere, no import), "composables/useName.ts", "lib/name.ts".`,
        ),
      content: z
        .string()
        .describe(
          "The complete file. Never a fragment, and never line-numbered text copied from pageRead.",
        ),
      pageId: z
        .uuid()
        .optional()
        .describe(
          "Only when repairing a page that already exists and you have not read it yet in this run.",
        ),
    }),
    execute: async (input, options) => {
      const project = await loadPageProjectContext(options, input.pageId);
      const { state } = project;
      const path = input.path.trim();

      if (!isEntry(path) && !PAGE_FILE_PATH_RE.test(path)) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `"${path}" is not a path this page can have.`,
          `Use ${PAGE_ENTRY_FILE}, components/<PascalName>.vue, composables/use<Name>.ts, or lib/<name>.ts — one level deep, no other directories.`,
        );
      }
      if (looksLineNumbered(input.content)) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "This content starts with line numbers — it is pageRead's output, not a file.",
          "Send the file itself: the numbers and the tab after them are added for reading and are not part of the source.",
        );
      }
      const ceiling = isEntry(path)
        ? PAGE_LIMITS.maxSourceChars
        : PAGE_LIMITS.maxFileChars;
      if (input.content.length > ceiling) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `${path} would be ${input.content.length.toString()} chars; one file may hold ${ceiling.toString()}.`,
          "Split it: move a region into components/<Name>.vue and use <Name> where it was.",
        );
      }
      const files =
        state.files[path] === undefined ? { ...state.files } : state.files;
      if (
        state.files[path] === undefined &&
        Object.keys(state.files).length >= PAGE_LIMITS.maxFiles
      ) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `This page already has ${PAGE_LIMITS.maxFiles.toString()} files.`,
          "Fold two of them together before adding another.",
        );
      }

      const lines = input.content.split("\n").length;
      const lint = lintDelta(path, state.files[path], input.content);
      measurePageWrite({
        mode: "write",
        path,
        before: state.files[path],
        after: input.content,
        charsEmitted: input.content.length,
        ...(lint.lintDelta !== undefined ? { lintDelta: lint.lintDelta } : {}),
      });
      await project.save({
        ...state,
        files: { ...files, [path]: input.content },
        seen: {
          ...state.seen,
          [path]: {
            ...state.seen[path],
            wroteAt: Date.now(),
            readAt: Date.now(),
            readHash: hashFileContent(input.content),
            editFailures: 0,
          },
        },
      });

      return {
        path,
        lines,
        written: true,
        ...(lines > SOFT_LINE_LIMIT
          ? {
              warning: `${lines.toString()} lines. Past ${SOFT_LINE_LIMIT.toString()} a file is doing several jobs — move a region into its own component while it is still easy.`,
            }
          : {}),
        ...lint,
      };
    },
  });
