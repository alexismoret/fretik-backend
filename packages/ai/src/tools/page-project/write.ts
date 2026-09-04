import { PAGE_ENTRY_FILE, PAGE_LIMITS } from "@fretik/shared/schemas/pages";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import { PAGE_JSON_FILE } from "../../services/page-project/page-json";
import { hashFileContent } from "../../services/page-project/store";
import {
  measurePageWrite,
  trackWrite,
} from "../../services/page-project/write-stats";
import {
  isEntry,
  isProjectPath,
  loadPageProjectContext,
  looksLineNumbered,
} from "./context";
import { lintDelta } from "./lint";

/**
 * Write whole files of the page — one, or the whole project in one call.
 *
 * The unit is a FILE because that is the unit a model rewrites reliably: over
 * two production builds, a fix touching 7% of a 2 000-line page re-emitted the
 * whole thing three times over. A 200-line component costs 2 000 tokens to
 * rewrite, and rewriting it is often the right answer.
 *
 * The unit of a CALL is a batch, for a reason the first multi-file build
 * measured: 15 writes arrived as 15 separate steps, and every step re-sent the
 * whole conversation — 39 model calls averaging 83 000 input tokens, 3.25M in
 * total, for 44K of output. Output fell 45% against the single-file design and
 * the bill still rose 19%, because the cost had moved to the input side. The
 * prompt asked for parallel calls and the model made none; a batch parameter
 * asks the same thing of the schema instead, where it does not depend on the
 * model's mood.
 *
 * Nothing here is visible to anyone until `pageBuild` is green — a file that
 * does not compile still lands, which is what makes fixing it an edit instead
 * of a re-emission.
 */

/** Past this a file stops being one thing, and the lint says so at build. */
const SOFT_LINE_LIMIT = 300;

const FileSchema = z.object({
  path: z
    .string()
    .describe(
      `"${PAGE_ENTRY_FILE}" (the page itself, or the shell when there are views), "components/Name.vue" (usable as <Name> anywhere, no import), "pages/index.vue" + "pages/name.vue" + "pages/name/[param].vue" (views with their own address — writing any of them requires pages/index.vue and a <RouterView /> in ${PAGE_ENTRY_FILE}), "composables/useName.ts", "lib/name.ts", "page.json".`,
    ),
  content: z
    .string()
    .describe(
      "The complete file. Never a fragment, and never line-numbered text copied from pageRead.",
    ),
});

/** One file's verdict, or the reason it was refused. */
interface FileOutcome {
  path: string;
  lines?: number;
  written?: boolean;
  warning?: string;
  error?: string;
  hint?: string;
  lintDelta?: string[];
}

export const createPageWriteTool = () =>
  tool({
    description: `Create or REPLACE whole files of the page. Pass \`files\` with EVERY file you are writing in one call — laying out a project is one pageWrite, not one per file. Nothing is visible to viewers until pageBuild is green, so a file that does not compile yet still lands here. Use it for a new file and for a change past ~20 lines; pageEdit is for a smaller one. Keep a file under ${SOFT_LINE_LIMIT.toString()} lines: one component, one responsibility.`,
    inputSchema: z.object({
      files: z
        .array(FileSchema)
        .min(1)
        .max(PAGE_LIMITS.maxFiles)
        .describe(
          "Every file this call writes. One call for the whole project beats one call per file: each extra call re-sends the entire conversation.",
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
      let state = project.state;
      const outcomes: FileOutcome[] = [];

      for (const entry of input.files) {
        const path = entry.path.trim();

        if (!isProjectPath(path)) {
          outcomes.push({
            path,
            error: `"${path}" is not a path this page can have.`,
            hint: `Use ${PAGE_ENTRY_FILE}, ${PAGE_JSON_FILE}, components/<PascalName>.vue, composables/use<Name>.ts, lib/<name>.ts, or a view: pages/index.vue, pages/<kebab>.vue, pages/<kebab>/[param].vue. Only pages/ nests, once — no other directories.`,
          });
          continue;
        }
        if (looksLineNumbered(entry.content)) {
          outcomes.push({
            path,
            error:
              "This content starts with line numbers — it is pageRead's output, not a file.",
            hint: "Send the file itself: the numbers and the tab after them are added for reading and are not part of the source.",
          });
          continue;
        }
        const ceiling = isEntry(path)
          ? PAGE_LIMITS.maxSourceChars
          : PAGE_LIMITS.maxFileChars;
        if (entry.content.length > ceiling) {
          outcomes.push({
            path,
            error: `${path} would be ${entry.content.length.toString()} chars; one file may hold ${ceiling.toString()}.`,
            hint: "Split it: move a region into components/<Name>.vue and use <Name> where it was.",
          });
          continue;
        }
        if (
          state.files[path] === undefined &&
          Object.keys(state.files).length >= PAGE_LIMITS.maxFiles
        ) {
          outcomes.push({
            path,
            error: `This page already has ${PAGE_LIMITS.maxFiles.toString()} files.`,
            hint: "Fold two of them together before adding another.",
          });
          continue;
        }

        const lines = entry.content.split("\n").length;
        const lint = lintDelta(path, state.files[path], entry.content);
        const measured = measurePageWrite({
          mode: "write",
          path,
          before: state.files[path],
          after: entry.content,
          charsEmitted: entry.content.length,
          ...(lint.lintDelta !== undefined
            ? { lintDelta: lint.lintDelta }
            : {}),
        });

        // Accumulated in memory and saved once: a batch that wrote file by file
        // would leave the working copy half-applied if the run died mid-loop,
        // and the whole point of the copy is that a write is never half-done.
        state = {
          ...state,
          writes: trackWrite(state.writes, measured),
          files: { ...state.files, [path]: entry.content },
          seen: {
            ...state.seen,
            [path]: {
              ...state.seen[path],
              wroteAt: Date.now(),
              readAt: Date.now(),
              readHash: hashFileContent(entry.content),
              editFailures: 0,
            },
          },
        };

        outcomes.push({
          path,
          lines,
          written: true,
          ...(lines > SOFT_LINE_LIMIT
            ? {
                warning: `${lines.toString()} lines. Past ${SOFT_LINE_LIMIT.toString()} a file is doing several jobs — move a region into its own component while it is still easy.`,
              }
            : {}),
          ...lint,
        });
      }

      const written = outcomes.filter((outcome) => outcome.written === true);
      if (written.length === 0) {
        const first = outcomes[0];
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          first?.error ?? "Nothing was written.",
          first?.hint ??
            "Send at least one file with a path this page can have.",
        );
      }

      await project.save(state);

      const refused = outcomes.filter((outcome) => outcome.written !== true);
      return {
        written: written.length,
        files: outcomes,
        ...(refused.length > 0
          ? {
              // Named rather than folded into the batch's success: a file the
              // agent believes it wrote and did not is the one failure that
              // survives all the way to a build error about a missing import.
              refused: refused.map((outcome) => outcome.path),
            }
          : {}),
      };
    },
  });
