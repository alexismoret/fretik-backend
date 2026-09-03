import {
  PAGE_LIMITS,
  PageDatasetSchema,
  PageVariableSchema,
} from "@fretik/shared/schemas/pages";
import { dryRunPage } from "@fretik/shared/services/pages/dry-run";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import {
  PAGE_JSON_FILE,
  parsePageJson,
} from "../../services/page-project/page-json";
import { loadPageProjectContext } from "./context";

/**
 * Run the page's datasets and show what they actually return — BEFORE any of
 * the design depends on them.
 *
 * Every page that shipped `[object Object]`, a raw id or an empty table was
 * designed against imagined fields. The measured cost of skipping this is
 * worse than a wrong column: a build over an app whose provider key was folded
 * wrongly got `needs_connection` five times, decided the data was unreachable,
 * and wrote seventy-eight invented rows into the page instead.
 */

export const createPageProbeTool = () =>
  tool({
    description: `Run datasets and return what they really hold: row count, real field names, real rows, and what to do when one refuses. Probe BEFORE you design — a column named from a guess is how a page ships "[object Object]". With no arguments it probes the datasets declared in ${PAGE_JSON_FILE}; pass \`datasets\` to try one before declaring it.`,
    inputSchema: z.object({
      datasets: z
        .array(PageDatasetSchema)
        .max(PAGE_LIMITS.maxDatasets)
        .optional()
        .describe(
          `Datasets to run, in the definition's own grammar. Omit to run what ${PAGE_JSON_FILE} declares.`,
        ),
      variables: z
        .array(PageVariableSchema)
        .max(PAGE_LIMITS.maxVariables)
        .optional()
        .describe(
          "Variables a dataset binds, with the `initial` to probe at. Omit to use what page.json declares.",
        ),
    }),
    execute: async (input, options) => {
      const project = await loadPageProjectContext(options);
      const { state } = project;

      let datasets = input.datasets;
      let variables = input.variables ?? [];
      if (datasets === undefined) {
        const raw = state.files[PAGE_JSON_FILE];
        if (raw === undefined) {
          return toolError(
            TOOL_ERROR_CODES.INVALID_ARGS,
            `No datasets given and no ${PAGE_JSON_FILE} to read them from.`,
            "Pass `datasets` to probe a source before declaring it.",
          );
        }
        const parsed = parsePageJson(raw);
        if (!parsed.ok) {
          return { ok: false, errors: parsed.errors };
        }
        datasets = parsed.value.datasets ?? [];
        if (input.variables === undefined) {
          variables = parsed.value.variables ?? [];
        }
      }
      if (datasets.length === 0) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          "There are no datasets to probe.",
          "Pass `datasets` — a collections query, an external app read, or inline rows.",
        );
      }

      const run = await dryRunPage({
        definition: {
          version: 3,
          variables,
          datasets,
          operations: [],
          // No code: this is a DATA probe, and compiling nothing is the point.
          code: { source: "" },
        },
        teamId: project.teamId,
        userId: project.userId,
      });

      return {
        samples: run.samples,
        ...(run.warnings.length > 0 ? { warnings: run.warnings } : {}),
      };
    },
  });
