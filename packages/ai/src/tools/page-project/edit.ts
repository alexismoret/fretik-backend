import { PAGE_ENTRY_FILE, PAGE_LIMITS } from "@fretik/shared/schemas/pages";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import {
  didYouMean,
  findAnchor,
  reindent,
  visualiseWhitespace,
} from "../../services/page-project/anchor";
import {
  hashFileContent,
  MAX_EDIT_FAILURES,
} from "../../services/page-project/store";
import { measurePageWrite } from "../../services/page-project/write-stats";
import { loadPageProjectContext } from "./context";
import { lintDelta } from "./lint";

/**
 * Change part of a file in place.
 *
 * Search-replace, not line numbers: line numbers go stale silently, and an
 * edit aimed at "line 40" corrupts whatever moved there. The anchor is looked
 * for four times, in decreasing strictness about WHITESPACE (`anchor.ts`) —
 * the one dimension a model reproduces approximately — and never about code.
 *
 * Three refusals are load-bearing, and each answers a measured failure:
 * editing a file this run has not read (the anchor is then a memory of another
 * page), an ambiguous anchor (silently picking one edits a line nobody looked
 * at), and the third failure in a row on one file (retrying a fourth time has
 * never once worked — rewriting it has).
 */

const MAX_LISTED_MATCHES = 5;
const DIFF_CONTEXT_CHARS = 240;

export const createPageEditTool = () =>
  tool({
    description: `Replace an exact piece of one file. Read the file first — an anchor you have not seen in THIS page is a memory of another one. \`oldString\` must match exactly once (whitespace is forgiven, code is not); use \`replaceAll\` to change every occurrence. For more than ~20 changed lines, or after two failed edits on a file, pageWrite the file instead. Nothing is visible to viewers until pageBuild is green.`,
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe(`Which file. Defaults to "${PAGE_ENTRY_FILE}".`),
      oldString: z
        .string()
        .min(1)
        .max(PAGE_LIMITS.maxEditChars)
        .describe(
          "The text to replace, copied from what you read — without the line numbers.",
        ),
      newString: z
        .string()
        .max(PAGE_LIMITS.maxEditChars)
        .describe("What it becomes. Empty deletes the anchor."),
      replaceAll: z
        .boolean()
        .optional()
        .describe(
          "Change every occurrence instead of refusing an ambiguous one.",
        ),
    }),
    execute: async (input, options) => {
      const project = await loadPageProjectContext(options);
      const { state } = project;
      const path = input.path ?? PAGE_ENTRY_FILE;
      const content = state.files[path];

      if (content === undefined) {
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `This page has no "${path}".`,
          `Its files are: ${Object.keys(state.files).join(", ") || "none yet"}.`,
        );
      }
      const seen = state.seen[path];
      if (seen?.readAt === undefined && seen?.wroteAt === undefined) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `You have not read ${path} in this run.`,
          `pageRead it first — an anchor composed from memory misses, and a miss costs more than the read.`,
        );
      }
      if (input.oldString === input.newString) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "oldString and newString are identical — nothing to change.",
        );
      }

      const found = findAnchor(content, input.oldString);

      if (!found.found) {
        // Already applied: the text this edit wanted to PRODUCE is there and
        // the text it wanted to replace is gone. That is a success nobody
        // needs to repeat, not a failure to reason about.
        if (input.newString.length >= 8 && content.includes(input.newString)) {
          return {
            path,
            applied: false,
            alreadyApplied: true,
            notice:
              "The file already reads the way this edit would leave it. Nothing was changed; move on.",
          };
        }
        const failures = (seen?.editFailures ?? 0) + 1;
        await project.save({
          ...state,
          seen: { ...state.seen, [path]: { ...seen, editFailures: failures } },
        });
        const hint = didYouMean(content, input.oldString);
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `That text is not in ${path}.`,
          failures >= MAX_EDIT_FAILURES
            ? `${failures.toString()} edits in a row have missed on this file. Stop re-anchoring: pageRead it, or pageWrite it whole.`
            : (hint ??
                `pageRead ${path} and copy the anchor from what it returns, without the line numbers.`),
        );
      }

      if (found.matches.length > 1 && input.replaceAll !== true) {
        const failures = (seen?.editFailures ?? 0) + 1;
        await project.save({
          ...state,
          seen: { ...state.seen, [path]: { ...seen, editFailures: failures } },
        });
        const lines = content.split("\n");
        const listed = found.matches
          .slice(0, MAX_LISTED_MATCHES)
          .map(
            (match) =>
              `  L${match.line.toString()}: ${visualiseWhitespace((lines[match.line - 1] ?? "").trim()).slice(0, 90)}`,
          )
          .join("\n");
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `That text occurs ${found.matches.length.toString()} times in ${path}:\n${listed}`,
          "Add a line of surrounding context so the anchor is unique, or set replaceAll: true to change every one.",
        );
      }

      // Applied back to front, so an earlier replacement cannot move a later
      // match's offsets.
      let next = content;
      for (const match of [...found.matches].reverse()) {
        const replacement =
          found.strategy === "indentation"
            ? reindent(input.newString, input.oldString, match)
            : input.newString;
        next = next.slice(0, match.start) + replacement + next.slice(match.end);
      }

      const ceiling =
        path === PAGE_ENTRY_FILE
          ? PAGE_LIMITS.maxSourceChars
          : PAGE_LIMITS.maxFileChars;
      if (next.length > ceiling) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `${path} would be ${next.length.toString()} chars; one file may hold ${ceiling.toString()}.`,
          "Split it: move a region into components/<Name>.vue and use <Name> where it was.",
        );
      }

      await project.save({
        ...state,
        files: { ...state.files, [path]: next },
        seen: {
          ...state.seen,
          [path]: {
            ...seen,
            wroteAt: Date.now(),
            readAt: Date.now(),
            readHash: hashFileContent(next),
            editFailures: 0,
          },
        },
      });

      const lint = lintDelta(path, content, next);
      // What an edit COSTS: the two strings it sent, against the lines it moved.
      measurePageWrite({
        mode: "edit",
        path,
        before: content,
        after: next,
        charsEmitted: input.oldString.length + input.newString.length,
        ...(lint.lintDelta !== undefined ? { lintDelta: lint.lintDelta } : {}),
      });

      const first = found.matches[0];
      return {
        path,
        applied: true,
        occurrences: found.matches.length,
        ...(found.strategy === "exact" ? {} : { matchedBy: found.strategy }),
        at: first !== undefined ? `line ${first.line.toString()}` : undefined,
        now: input.newString.slice(0, DIFF_CONTEXT_CHARS),
        ...lint,
      };
    },
  });
